import { createHash } from 'node:crypto';
import type { ApplicationSession } from './application-automation.js';
import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { inferSeason } from './core/early-career.js';
import { fingerprint, normalizeUrl } from './core/normalize.js';
import { buildPostingIdentity, canonicalizePostingUrl } from './identity/posting.js';
import { providerEvidenceForOccurrence, reviewedProviderEvidenceError, reviewedProviderUrlReference } from './identity/reviewed-provider.js';
import { notificationDedupeKey } from './notifications.js';
import type { CatalogRelease } from './catalog-groups.js';
import { isOfficialOccurrence } from './sources/provenance.js';
import type { ApplicationRecord, DeliveryReceipt, Internship, PostingIdentity, ProviderPostingEvidence, SourceCheckpoint, SourceOccurrence } from './types.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

type CatalogRow = {
  pk: string; sk: string; kind: string; value: string;
  url_key?: string | null; fingerprint_key?: string | null; sms_pending?: number; digest_pending?: number;
  catalog_state?: string | null; catalog_sort_key?: string | null; search_text?: string | null;
  source_classes?: string | null; source_id?: string | null; external_id?: string | null;
};
type UserRow = { user_id: string; item_key: string; kind: string; value: string; session_id?: string | null; receipt_state?: string | null; expires_at?: number | null };
type ProposalRow = { id: string; job_id: string };
type CatalogWrite = { before?: CatalogRow; pk: string; sk: string; kind: string; value: string; columns?: Partial<CatalogRow> };
type UserWrite = { before?: UserRow; userId: string; itemKey: string; kind: string; value: string; columns?: Partial<UserRow> };

// Reviewed 2026-08-28 against the employer's live pages. These custom
// Greenhouse handoffs expose gh_jid on /careers/job and redirect to the exact
// first-party posting; stripping gh_src revealed the historical URL pairs.
const reviewedUrlConsolidations = [
  {
    matchUrl: 'https://www.hudsonrivertrading.com/careers/job?gh_jid=8059837',
    officialUrl: 'https://www.hudsonrivertrading.com/hrt-job/algorithm-development-quant-research-phd-internship-summer-2027',
    title: 'Algorithm Development (Quant Research & Trading) PhD Internship – Summer 2027',
    locations: ['London', 'New York', 'Singapore'],
  },
  {
    matchUrl: 'https://www.hudsonrivertrading.com/careers/job?gh_jid=8052083',
    officialUrl: 'https://www.hudsonrivertrading.com/hrt-job/software-engineering-internship-c-or-python-summer-2027',
    title: 'Software Engineering Internship (C++ or Python) – Summer 2027',
    locations: ['Austin', 'Chicago', 'London', 'New York'],
  },
  {
    matchUrl: 'https://www.hudsonrivertrading.com/careers/job?gh_jid=7964062',
    officialUrl: 'https://www.hudsonrivertrading.com/hrt-job/algorithm-development-quant-research-internship-summer-2027',
    title: 'Algorithm Development (Quant Research & Trading) Internship – Summer 2027',
    locations: ['London', 'New York', 'Singapore'],
  },
] as const;

export interface PostingIdentityRepairPlan {
  scope: PostingIdentityRepairScope;
  repairToken: string;
  providerGroups: number;
  duplicateGroups: number;
  duplicateJobs: number;
  eligibleDuplicateGroups: number;
  eligibleDuplicateJobs: number;
  unresolvedDuplicateGroups: number;
  jobUpdates: number;
  jobDeletes: number;
  aliasWrites: number;
  occurrenceRemaps: number;
  applicationRemaps: number;
  applicationMerges: number;
  sessionRemaps: number;
  receiptRemaps: number;
  receiptMerges: number;
  releaseRemaps: number;
  proposalRemaps: number;
  outboxRows: number;
  conflicts: string[];
  presentationDisagreements: PresentationDisagreement[];
  samples: Array<{
    canonicalJobId: string;
    duplicateJobIds: string[];
    providerIdentity: string;
    applyEligible: boolean;
    disagreementFields: PresentationField[];
  }>;
  expectedChanges: number;
  applied: boolean;
  projectionRefreshRequired: boolean;
}

export type PostingIdentityRepairScope = 'all' | 'identity' | 'occurrences';

export type PresentationField =
  | 'employerIdentity'
  | 'employerName'
  | 'title'
  | 'location'
  | 'destinationUrl'
  | 'admissionState'
  | 'admissionReasons';

export interface PresentationDisagreement {
  providerIdentity: string;
  canonicalJobId: string;
  duplicateJobIds: string[];
  fields: PresentationField[];
  values: Partial<Record<PresentationField, Array<{ jobId: string; value: unknown }>>>;
}

type InternalPlan = PostingIdentityRepairPlan & {
  catalogWrites: CatalogWrite[]; catalogDeletes: CatalogRow[];
  userWrites: UserWrite[]; userDeletes: UserRow[]; proposalUpdates: ProposalRow[];
};

const parse = <T>(value: string): T => JSON.parse(value) as T;
const earliest = (values: string[]) => [...values].sort()[0]!;
const latest = (values: string[]) => [...values].sort().at(-1)!;
const firstSeen = (job: Internship) => job.firstSeenAt || job.catalogVisibleAt || job.lastSeenAt;
const occurrenceKey = (value: SourceOccurrence) => `${value.sourceId}\0${value.externalId ?? ''}\0${value.document ?? ''}\0${value.row ?? ''}`;

function normalizedOccurrenceSeason(occurrence: SourceOccurrence): SourceOccurrence {
  const multiSeason = /\b(?:winter|spring|summer|fall)\s*[/-]\s*(?:winter|spring|summer|fall)\s*(?:intern(?:ship)?\s*)?20\d{2}\b/i.test(occurrence.title);
  return multiSeason
    ? { ...occurrence, season: inferSeason(occurrence.title, '', new Date(0)) }
    : occurrence;
}

function withProviderEvidence(occurrence: SourceOccurrence): SourceOccurrence {
  const normalized = normalizedOccurrenceSeason(occurrence);
  if (normalized.providerEvidence || !normalized.externalId) return normalized;
  const evidence = providerEvidenceForOccurrence(normalized.sourceId, normalized.externalId, [normalized.applyUrl]);
  return evidence ? { ...normalized, providerEvidence: evidence } : normalized;
}

function mergedOccurrenceEvidence(values: SourceOccurrence[]): SourceOccurrence[] {
  const merged = new Map<string, SourceOccurrence>();
  for (const occurrence of values) {
    const key = occurrenceKey(occurrence);
    const previous = merged.get(key);
    const providerEvidence = occurrence.providerEvidence && previous?.providerEvidence
      ? { ...previous.providerEvidence, ...occurrence.providerEvidence,
        urls: [...new Set([...previous.providerEvidence.urls, ...occurrence.providerEvidence.urls])].sort() }
      : occurrence.providerEvidence ?? previous?.providerEvidence;
    const provenance = occurrence.provenance ?? previous?.provenance;
    merged.set(key, withProviderEvidence({
      ...previous,
      ...occurrence,
      ...(provenance ? { provenance } : {}),
      ...(providerEvidence ? { providerEvidence } : {}),
    }));
  }
  return [...merged.values()];
}

function jobColumns(job: Internship): Partial<CatalogRow> {
  return {
    url_key: job.normalizedUrl,
    fingerprint_key: job.fingerprint,
    sms_pending: job.notification.smsPending ? 1 : 0,
    digest_pending: job.notification.digestPending ? 1 : 0,
    catalog_state: job.technical === false ? null : job.open ? 'OPEN' : 'CLOSED',
    catalog_sort_key: job.technical === false ? null : job.open ? openCatalogSortKey(job) : `${job.lastSeenAt}#${job.jobId}`,
    search_text: job.technical === false ? null : catalogSearchText(job),
    source_classes: job.technical === false ? null : JSON.stringify(catalogSourceClasses(job)),
  };
}

function mergeJob(canonical: Internship, members: Internship[], identity: PostingIdentity, official?: SourceOccurrence): Internship {
  const sourceReferences = [...new Map(members.flatMap((job) => job.sourceReferences).map((item) => [occurrenceKey(item), item])).values()];
  const smsSentAt = members.map((job) => job.notification.smsSentAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const digestedAt = members.map((job) => job.notification.digestedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const company = official?.company ?? canonical.company;
  const title = official?.title ?? canonical.title;
  const location = official?.location ?? canonical.location;
  const evidenceDateValue = official?.providerTimestamp?.value ?? canonical.lastSeenAt;
  const parsedEvidenceDate = Date.parse(evidenceDateValue);
  const evidenceDate = new Date(Number.isNaN(parsedEvidenceDate) ? 0 : parsedEvidenceDate);
  const season = official ? inferSeason(official.title, '', evidenceDate) : canonical.season;
  const applyUrl = official ? canonicalizePostingUrl(official.applyUrl) : canonical.applyUrl;
  const compensation = [...members]
    .sort((a, b) => (b.compensation.maxHourlyUSD ?? b.compensation.minHourlyUSD ?? 0)
      - (a.compensation.maxHourlyUSD ?? a.compensation.minHourlyUSD ?? 0))
    .find((job) => job.compensation.raw || job.compensation.maxHourlyUSD || job.compensation.minHourlyUSD)?.compensation
    ?? canonical.compensation;
  return {
    ...canonical,
    company,
    title,
    location,
    ...(official?.locations ? { locations: official.locations } : {}),
    season,
    applyUrl,
    normalizedUrl: normalizeUrl(applyUrl),
    fingerprint: fingerprint(company, title, location, season),
    compensation,
    requirements: {
      requiresUsCitizenship: members.some((job) => job.requirements?.requiresUsCitizenship),
      advancedDegreeRequired: members.some((job) => job.requirements?.advancedDegreeRequired),
    },
    postingIdentity: identity,
    sourceReferences,
    open: members.some((job) => job.open),
    technical: members.some((job) => job.technical !== false),
    firstSeenAt: earliest(members.map(firstSeen)),
    catalogVisibleAt: earliest(members.map((job) => job.catalogVisibleAt ?? firstSeen(job))),
    lastSeenAt: latest(members.map((job) => job.lastSeenAt)),
    notification: {
      smsPending: !smsSentAt && members.some((job) => job.notification.smsPending),
      digestPending: !digestedAt && members.some((job) => job.notification.digestPending),
      ...(smsSentAt ? { smsSentAt } : {}), ...(digestedAt ? { digestedAt } : {}),
    },
  };
}

function statusRank(status: ApplicationRecord['status']) {
  return ({ saved: 0, applied: 1, assessment: 2, interview: 3, rejected: 4, withdrawn: 4, offer: 5 })[status];
}

function receiptRank(receipt: DeliveryReceipt) {
  if (receipt.status === 'ok' || receipt.deliveryState === 'delivered') return 5;
  if (receipt.deliveryState === 'accepted' || receipt.deliveryState === 'unknown' || receipt.status === 'pending') return 4;
  if (receipt.deliveryState === 'definitive-failure') return 3;
  return receipt.status === 'retryable' ? 2 : 1;
}

function uniqueNotes(records: ApplicationRecord[]): string | undefined {
  const notes = [...new Set([...records].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.applicationId.localeCompare(b.applicationId))
    .map((item) => item.notes?.trim()).filter((value): value is string => Boolean(value)))];
  return notes.length ? notes.join('\n\n') : undefined;
}

function providerKey(evidence: ProviderPostingEvidence) {
  return `${evidence.provider}:${evidence.tenant.toLowerCase()}:${evidence.postingId.toLowerCase()}`;
}

function checkpointEvidenceForUnscopedGreenhouseEmbed(
  input: string,
  checkpoints: Map<string, SourceCheckpoint>,
): ProviderPostingEvidence | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if ((host !== 'boards.greenhouse.io' && host !== 'job-boards.greenhouse.io')
      || !/^\/embed\/job_app\/?$/i.test(url.pathname)) return undefined;
  const postingId = url.searchParams.get('token');
  if (!postingId || !/^\d+$/.test(postingId)) return undefined;
  const matches = [...checkpoints.entries()].flatMap(([sourceId, checkpoint]) => {
    if (!checkpoint.activeExternalIds?.includes(postingId)) return [];
    const evidence = providerEvidenceForOccurrence(sourceId, postingId, [input]);
    return evidence?.provider === 'greenhouse' ? [evidence] : [];
  });
  const unique = [...new Map(matches.map((item) => [providerKey(item), item])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

function evidenceForJob(job: Internship, checkpoints: Map<string, SourceCheckpoint>): ProviderPostingEvidence[] {
  const result: ProviderPostingEvidence[] = [];
  for (const occurrence of job.sourceReferences) {
    const direct = occurrence.providerEvidence
      ?? (occurrence.externalId ? providerEvidenceForOccurrence(occurrence.sourceId, occurrence.externalId, [occurrence.applyUrl]) : undefined);
    if (direct) result.push(direct);
    const embedded = checkpointEvidenceForUnscopedGreenhouseEmbed(occurrence.applyUrl, checkpoints);
    if (embedded) result.push(embedded);
    const parsed = reviewedProviderUrlReference(occurrence.applyUrl);
    if (parsed.outcome !== 'match') continue;
    if (checkpoints.get(parsed.reference.sourceId)?.activeExternalIds?.includes(parsed.reference.postingId)) {
      result.push({
        provider: parsed.reference.provider, tenant: parsed.reference.tenant, postingId: parsed.reference.postingId,
        sourceId: parsed.reference.sourceId, urls: [occurrence.applyUrl],
      });
    }
  }
  return [...new Map(result.map((item) => [providerKey(item), item])).values()];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

type FutureAdmissionJob = Internship & {
  employerId?: string;
  admissionState?: unknown;
  admissionReasons?: unknown;
  admission?: { state?: unknown; reasons?: unknown };
  catalogAdmission?: { state?: unknown; reasons?: unknown };
};

function presentation(job: Internship): Record<PresentationField, unknown> {
  const future = job as FutureAdmissionJob;
  const identity = (job.internshipIdentity as { company?: { canonicalId?: string } } | undefined)?.company?.canonicalId;
  return {
    employerIdentity: future.employerId ?? identity,
    employerName: job.company,
    title: job.title,
    location: { location: job.location, locations: job.locations ?? [] },
    destinationUrl: job.applyUrl,
    admissionState: future.catalogAdmission?.state ?? future.admission?.state ?? future.admissionState,
    admissionReasons: future.catalogAdmission?.reasons ?? future.admission?.reasons ?? future.admissionReasons,
  };
}

function comparablePresentationValue(field: PresentationField, value: unknown): unknown {
  if (field !== 'destinationUrl' || typeof value !== 'string') return value;
  try { return canonicalizePostingUrl(value); } catch { return value; }
}

function presentationDisagreement(
  providerIdentity: string,
  canonicalJobId: string,
  members: Internship[],
  official?: SourceOccurrence,
): PresentationDisagreement | undefined {
  const values = {} as PresentationDisagreement['values'];
  const fields: PresentationField[] = [];
  for (const field of Object.keys(presentation(members[0]!)) as PresentationField[]) {
    if (official && ['employerName', 'title', 'location', 'destinationUrl'].includes(field)) continue;
    const observed = members.map((job) => ({ jobId: job.jobId, value: presentation(job)[field] }));
    if (new Set(observed.map((item) => JSON.stringify(stable(comparablePresentationValue(field, item.value))))).size <= 1) continue;
    fields.push(field);
    values[field] = observed;
  }
  if (!fields.length) return undefined;
  return {
    providerIdentity,
    canonicalJobId,
    duplicateJobIds: members.slice(1).map((job) => job.jobId),
    fields,
    values,
  };
}

/** A directly attached official connector occurrence is reviewed presentation
 * evidence only when it matches the exact provider tenant and immutable ID. */
function officialPresentation(members: Internship[], evidence: ProviderPostingEvidence): SourceOccurrence | undefined {
  const matches = members.flatMap((job) => job.sourceReferences).filter((reference) =>
    reference.provenance === 'official-ats'
    && reference.sourceId === evidence.sourceId
    && reference.externalId?.toLowerCase() === evidence.postingId.toLowerCase());
  if (!matches.length) return undefined;
  const presentations = new Set(matches.map((reference) => JSON.stringify(stable({
    company: reference.company,
    title: reference.title,
    location: reference.location,
    locations: reference.locations ?? [],
    applyUrl: canonicalizePostingUrl(reference.applyUrl),
  }))));
  if (presentations.size !== 1) return undefined;
  return [...matches].sort((a, b) => (b.providerTimestamp?.value ?? '').localeCompare(a.providerTimestamp?.value ?? ''))[0];
}

export function postingIdentityRepairPlan(
  catalogRows: CatalogRow[],
  userRows: UserRow[],
  proposalRows: ProposalRow[] = [],
  scope: PostingIdentityRepairScope = 'all',
): InternalPlan {
  const conflicts: string[] = [];
  const checkpoints = new Map(catalogRows.filter((row) => row.kind === 'checkpoint').flatMap((row) => {
    try { const value = parse<SourceCheckpoint>(row.value); return [[value.sourceId, value] as const]; } catch { return []; }
  }));
  const occurrencesByJob = new Map<string, SourceOccurrence[]>();
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const state = parse<{ jobId: string; occurrence: SourceOccurrence }>(row.value);
      occurrencesByJob.set(state.jobId, [...(occurrencesByJob.get(state.jobId) ?? []), state.occurrence]);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed source occurrence JSON`); }
  }
  const jobRows = catalogRows.filter((row) => row.kind === 'internship');
  const catalogByKey = new Map(catalogRows.map((row) => [`${row.pk}\0${row.sk}`, row]));
  const groups = new Map<string, Array<{ row: CatalogRow; job: Internship; evidence: ProviderPostingEvidence }>>();
  for (const row of jobRows) {
    let job: Internship;
    try {
      job = parse<Internship>(row.value);
      job = { ...job, sourceReferences: mergedOccurrenceEvidence([
        ...job.sourceReferences, ...(occurrencesByJob.get(job.jobId) ?? []),
      ]) };
    } catch { conflicts.push(`${row.pk}: malformed internship JSON`); continue; }
    const invalidEvidence = job.sourceReferences.flatMap((reference) => {
      if (!reference.providerEvidence) return [];
      const error = reviewedProviderEvidenceError(reference.providerEvidence);
      return error ? [`${job.jobId}:${reference.sourceId}: ${error}`] : [];
    });
    if (invalidEvidence.length) { conflicts.push(...invalidEvidence); continue; }
    const evidence = evidenceForJob(job, checkpoints);
    if (evidence.length > 1) { conflicts.push(`${job.jobId}: reviewed provider evidence disagrees (${evidence.map(providerKey).sort().join(', ')})`); continue; }
    if (!evidence.length) continue;
    const key = providerKey(evidence[0]!);
    groups.set(key, [...(groups.get(key) ?? []), { row, job, evidence: evidence[0]! }]);
  }

  const canonicalByJobId = new Map<string, string>();
  const canonicalJobs = new Map<string, Internship>();
  const catalogWrites: CatalogWrite[] = [];
  const catalogDeletes: CatalogRow[] = [];
  const samples: PostingIdentityRepairPlan['samples'] = [];
  const presentationDisagreements: PresentationDisagreement[] = [];
  let duplicateGroups = 0;
  let duplicateJobs = 0;
  let eligibleDuplicateGroups = 0;
  let eligibleDuplicateJobs = 0;
  for (const [key, values] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...values].sort((a, b) => firstSeen(a.job).localeCompare(firstSeen(b.job)) || a.job.jobId.localeCompare(b.job.jobId));
    const canonical = ordered[0]!;
    const official = officialPresentation(ordered.map((item) => item.job), canonical.evidence);
    const disagreement = ordered.length > 1
      ? presentationDisagreement(key, canonical.job.jobId, ordered.map((item) => item.job), official)
      : undefined;
    if (ordered.length > 1) {
      duplicateGroups += 1;
      duplicateJobs += ordered.length - 1;
      if (disagreement) presentationDisagreements.push(disagreement);
      else {
        eligibleDuplicateGroups += 1;
        eligibleDuplicateJobs += ordered.length - 1;
      }
      samples.push({
        canonicalJobId: canonical.job.jobId,
        duplicateJobIds: ordered.slice(1).map((item) => item.job.jobId),
        providerIdentity: key,
        applyEligible: !disagreement,
        disagreementFields: disagreement?.fields ?? [],
      });
    }
    // Provider identity alone does not authorize a presentation choice. An
    // exact official connector occurrence may resolve presentation fields;
    // every remaining disagreement still waits for a reviewed #120 decision.
    if (disagreement) continue;
    const urls = ordered.flatMap(({ job }) => [job.applyUrl, ...job.sourceReferences.map((item) => item.applyUrl)]);
    const retainedIdentity = ordered.length === 1
      && canonical.job.postingIdentity?.provider === canonical.evidence.provider
      && canonical.job.postingIdentity.tenant?.toLowerCase() === canonical.evidence.tenant.toLowerCase()
      && canonical.job.postingIdentity.providerPostingId?.toLowerCase() === canonical.evidence.postingId.toLowerCase()
      ? canonical.job.postingIdentity
      : undefined;
    const identity = retainedIdentity
      ? { ...retainedIdentity }
      : buildPostingIdentity({ applicationUrl: canonical.job.applyUrl, providerEvidence: { ...canonical.evidence, urls } });
    identity.canonicalJobId = canonical.job.jobId;
    const merged = retainedIdentity
      ? canonical.job
      : mergeJob(canonical.job, ordered.map((item) => item.job), identity, official);
    canonicalJobs.set(canonical.job.jobId, merged);
    for (const item of ordered) canonicalByJobId.set(item.job.jobId, canonical.job.jobId);
    if (JSON.stringify(stable(merged)) !== JSON.stringify(stable(parse<Internship>(canonical.row.value)))) {
      catalogWrites.push({ before: canonical.row, pk: canonical.row.pk, sk: canonical.row.sk, kind: 'internship', value: JSON.stringify(merged), columns: jobColumns(merged) });
    }
    catalogDeletes.push(...ordered.slice(1).map((item) => item.row));
    const duplicateIds = new Set(ordered.slice(1).map((item) => item.job.jobId));
    const remappedAliasKeys = new Set<string>();
    for (const row of catalogRows.filter((item) => item.kind === 'posting-alias')) {
      try {
        const claim = parse<{ alias: string; canonicalJobId: string }>(row.value);
        if (!duplicateIds.has(claim.canonicalJobId)) continue;
        remappedAliasKeys.add(`${row.pk}\0${row.sk}`);
        catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind,
          value: JSON.stringify({ ...claim, canonicalJobId: canonical.job.jobId }) });
      } catch { conflicts.push(`${row.pk}:${row.sk}: malformed posting alias JSON`); }
    }
    const aliasValues = new Set(identity.aliases.filter((item) => item.value.startsWith('provider:')).map((item) => item.value));
    aliasValues.add(`provider:${key}`);
    for (const alias of [...aliasValues].sort()) {
      const pk = `POSTING_ALIAS#${alias}`; const existing = catalogByKey.get(`${pk}\0CLAIM`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
        if (remappedAliasKeys.has(`${pk}\0CLAIM`)) continue;
        if (claim.canonicalJobId !== canonical.job.jobId) conflicts.push(`${alias}: already claimed by ${claim.canonicalJobId ?? 'an invalid row'}`);
        continue;
      }
      catalogWrites.push({ pk, sk: 'CLAIM', kind: 'posting-alias', value: JSON.stringify({ alias, canonicalJobId: canonical.job.jobId, claimedAt: 'identity-repair' }) });
    }
    for (const duplicate of ordered.slice(1)) {
      const pk = `JOB_ID_ALIAS#${duplicate.job.jobId}`; const existing = catalogByKey.get(`${pk}\0TARGET`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
        if (claim.canonicalJobId !== canonical.job.jobId) conflicts.push(`${duplicate.job.jobId}: legacy alias already targets ${claim.canonicalJobId ?? 'an invalid row'}`);
        continue;
      }
      catalogWrites.push({ pk, sk: 'TARGET', kind: 'job-id-alias', value: JSON.stringify({ oldJobId: duplicate.job.jobId, canonicalJobId: canonical.job.jobId, createdBy: 'posting-identity-repair' }) });
    }
  }

  for (const decision of reviewedUrlConsolidations) {
    const values = jobRows.flatMap((row) => {
      try {
        const job = parse<Internship>(row.value);
        const normalizedUrl = normalizeUrl(job.applyUrl);
        return normalizedUrl === decision.matchUrl || normalizedUrl === decision.officialUrl ? [{ row, job }] : [];
      } catch { return []; }
    });
    if (values.length < 2) continue;
    const ordered = [...values].sort((a, b) => firstSeen(a.job).localeCompare(firstSeen(b.job)) || a.job.jobId.localeCompare(b.job.jobId));
    const canonical = ordered[0]!;
    const duplicateIds = new Set(ordered.slice(1).map((item) => item.job.jobId));
    duplicateGroups += 1;
    duplicateJobs += ordered.length - 1;
    eligibleDuplicateGroups += 1;
    eligibleDuplicateJobs += ordered.length - 1;
    samples.push({
      canonicalJobId: canonical.job.jobId,
      duplicateJobIds: [...duplicateIds],
      providerIdentity: `url:${decision.matchUrl}`,
      applyEligible: true,
      disagreementFields: [],
    });
    const observedUrls = ordered.flatMap(({ job }) => [job.applyUrl, ...job.sourceReferences.map((reference) => reference.applyUrl)]);
    const identity = buildPostingIdentity({
      applicationUrl: decision.matchUrl,
      finalOfficialUrl: decision.officialUrl,
      observedUrls,
    });
    identity.canonicalJobId = canonical.job.jobId;
    const mergedBase = mergeJob(canonical.job, ordered.map((item) => item.job), identity);
    const evidenceDate = new Date(Number.isNaN(Date.parse(mergedBase.lastSeenAt)) ? 0 : Date.parse(mergedBase.lastSeenAt));
    const season = inferSeason(decision.title, '', evidenceDate);
    const location = decision.locations.join('; ');
    const merged: Internship = {
      ...mergedBase,
      company: 'Hudson River Trading',
      title: decision.title,
      location,
      locations: [...decision.locations],
      season,
      applyUrl: decision.officialUrl,
      normalizedUrl: normalizeUrl(decision.officialUrl),
      fingerprint: fingerprint('Hudson River Trading', decision.title, location, season),
    };
    canonicalJobs.set(canonical.job.jobId, merged);
    for (const item of ordered) canonicalByJobId.set(item.job.jobId, canonical.job.jobId);
    catalogWrites.push({ before: canonical.row, pk: canonical.row.pk, sk: canonical.row.sk, kind: 'internship', value: JSON.stringify(merged), columns: jobColumns(merged) });
    catalogDeletes.push(...ordered.slice(1).map((item) => item.row));

    const remappedAliasKeys = new Set<string>();
    for (const row of catalogRows.filter((item) => item.kind === 'posting-alias')) {
      try {
        const claim = parse<{ alias: string; canonicalJobId: string }>(row.value);
        if (!duplicateIds.has(claim.canonicalJobId)) continue;
        remappedAliasKeys.add(`${row.pk}\0${row.sk}`);
        catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind,
          value: JSON.stringify({ ...claim, canonicalJobId: canonical.job.jobId }) });
      } catch { conflicts.push(`${row.pk}:${row.sk}: malformed posting alias JSON`); }
    }
    for (const alias of identity.aliases.map((item) => item.value)) {
      const pk = `POSTING_ALIAS#${alias}`;
      const existing = catalogByKey.get(`${pk}\0CLAIM`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
        if (remappedAliasKeys.has(`${pk}\0CLAIM`) || claim.canonicalJobId === canonical.job.jobId) continue;
        conflicts.push(`${alias}: already claimed by ${claim.canonicalJobId ?? 'an invalid row'}`);
        continue;
      }
      catalogWrites.push({ pk, sk: 'CLAIM', kind: 'posting-alias', value: JSON.stringify({ alias, canonicalJobId: canonical.job.jobId, claimedAt: 'identity-repair' }) });
    }
    for (const duplicateId of duplicateIds) {
      const pk = `JOB_ID_ALIAS#${duplicateId}`;
      const existing = catalogByKey.get(`${pk}\0TARGET`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
        if (claim.canonicalJobId !== canonical.job.jobId) conflicts.push(`${duplicateId}: legacy alias already targets ${claim.canonicalJobId ?? 'an invalid row'}`);
        continue;
      }
      catalogWrites.push({ pk, sk: 'TARGET', kind: 'job-id-alias', value: JSON.stringify({ oldJobId: duplicateId, canonicalJobId: canonical.job.jobId, createdBy: 'posting-identity-repair' }) });
    }
  }

  // Identity aliases can attach occurrences that older catalog rows never
  // received. Materialize the authoritative occurrence set before applying
  // the repair so a replay is a no-op rather than reopening or reclassifying
  // the same canonical posting on its next poll.
  const memberIdsByCanonical = new Map<string, string[]>();
  for (const row of jobRows) {
    try {
      const job = parse<Internship>(row.value);
      const canonical = canonicalByJobId.get(job.jobId) ?? job.jobId;
      memberIdsByCanonical.set(canonical, [...(memberIdsByCanonical.get(canonical) ?? []), job.jobId]);
    } catch { /* Malformed internship JSON was reported above. */ }
  }
  if (scope !== 'identity') for (const row of jobRows) {
    let stored: Internship;
    try { stored = parse<Internship>(row.value); } catch { continue; }
    const canonicalId = canonicalByJobId.get(stored.jobId) ?? stored.jobId;
    if (canonicalId !== stored.jobId) continue;
    const base = canonicalJobs.get(canonicalId) ?? stored;
    const occurrenceReferences = (memberIdsByCanonical.get(canonicalId) ?? [canonicalId])
      .flatMap((jobId) => occurrencesByJob.get(jobId) ?? []);
    const sourceReferences = mergedOccurrenceEvidence([...base.sourceReferences, ...occurrenceReferences]);
    const officialSeason = sourceReferences.find((reference) => isOfficialOccurrence(reference)
      && /\b(?:winter|spring|summer|fall)\s*[/-]\s*(?:winter|spring|summer|fall)\s*(?:intern(?:ship)?\s*)?20\d{2}\b/i.test(reference.title))?.season;
    const season = officialSeason ?? base.season;
    const synchronized: Internship = {
      ...base,
      sourceReferences,
      season,
      fingerprint: fingerprint(base.company, base.title, base.location, season),
    };
    canonicalJobs.set(canonicalId, synchronized);
    const changed = JSON.stringify(stable(synchronized)) !== JSON.stringify(stable(stored));
    const priorWrite = catalogWrites.findIndex((write) => write.pk === row.pk && write.sk === row.sk && write.kind === 'internship');
    if (!changed) {
      if (priorWrite >= 0) catalogWrites.splice(priorWrite, 1);
    } else {
      const write = { before: row, pk: row.pk, sk: row.sk, kind: 'internship', value: JSON.stringify(synchronized), columns: jobColumns(synchronized) };
      if (priorWrite >= 0) catalogWrites[priorWrite] = write;
      else catalogWrites.push(write);
    }

    const urlAliases = buildPostingIdentity({
      applicationUrl: synchronized.applyUrl,
      observedUrls: synchronized.sourceReferences.map((reference) => reference.applyUrl),
    }).aliases.filter((alias) => alias.value.startsWith('url:'));
    for (const alias of urlAliases) {
      const pk = `POSTING_ALIAS#${alias.value}`;
      const existing = catalogByKey.get(`${pk}\0CLAIM`);
      const planned = catalogWrites.find((item) => item.pk === pk && item.sk === 'CLAIM');
      const owner = planned
        ? parse<{ canonicalJobId?: string }>(planned.value).canonicalJobId
        : existing ? parse<{ canonicalJobId?: string }>(existing.value).canonicalJobId : undefined;
      if (owner && owner !== canonicalId) {
        conflicts.push(`${alias.value}: already claimed by ${owner}`);
        continue;
      }
      if (owner) continue;
      catalogWrites.push({ pk, sk: 'CLAIM', kind: 'posting-alias', value: JSON.stringify({
        alias: alias.value, canonicalJobId: canonicalId, claimedAt: 'identity-repair',
      }) });
    }
  }

  let occurrenceRemaps = 0;
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const value = parse<{ jobId: string; occurrence: SourceOccurrence }>(row.value);
      const canonical = canonicalByJobId.get(value.jobId) ?? value.jobId;
      const remapped = canonical !== value.jobId;
      const occurrence = remapped ? withProviderEvidence(value.occurrence) : normalizedOccurrenceSeason(value.occurrence);
      const normalized = JSON.stringify(stable(occurrence)) !== JSON.stringify(stable(value.occurrence));
      if (!remapped && !normalized) continue;
      if (remapped) occurrenceRemaps += 1;
      catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind, value: JSON.stringify({
        ...value, jobId: canonical, occurrence,
      }) });
    } catch { /* Malformed occurrence JSON was reported while building reviewed evidence. */ }
  }

  const userWrites: UserWrite[] = [];
  const userDeletes: UserRow[] = [];
  const applicationIdAliases = new Map<string, string>();
  let applicationRemaps = 0; let applicationMerges = 0;
  const applicationGroups = new Map<string, Array<{ row: UserRow; value: ApplicationRecord }>>();
  for (const row of userRows.filter((item) => item.kind === 'application')) {
    const value = parse<ApplicationRecord>(row.value); const canonical = canonicalByJobId.get(value.jobId);
    if (!canonical) continue;
    const group = `${row.user_id}\0${canonical}`;
    applicationGroups.set(group, [...(applicationGroups.get(group) ?? []), { row, value }]);
  }
  for (const [group, records] of applicationGroups) {
    const canonicalJobId = group.split('\0')[1]!;
    if (records.every((item) => item.value.jobId === canonicalJobId)) continue;
    const ordered = [...records].sort((a, b) => b.value.updatedAt.localeCompare(a.value.updatedAt) || a.value.applicationId.localeCompare(b.value.applicationId));
    const keeper = ordered[0]!;
    const strongest = [...ordered].sort((a, b) => statusRank(b.value.status) - statusRank(a.value.status) || b.value.updatedAt.localeCompare(a.value.updatedAt))[0]!.value;
    const appliedAt = ordered.map((item) => item.value.appliedAt).filter((value): value is string => Boolean(value)).sort()[0];
    const detection = ordered.map((item) => item.value.detection).filter((value): value is NonNullable<ApplicationRecord['detection']> => Boolean(value))
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0];
    const applyMode = strongest.applyMode ?? ordered.map((item) => item.value.applyMode).find((value) => value !== undefined);
    const notes = uniqueNotes(ordered.map((item) => item.value));
    const value: ApplicationRecord = {
      ...keeper.value,
      jobId: canonicalJobId,
      status: strongest.status,
      createdAt: earliest(ordered.map((item) => item.value.createdAt)),
      updatedAt: latest(ordered.map((item) => item.value.updatedAt)),
      ...(appliedAt ? { appliedAt } : {}),
      ...(detection ? { detection } : {}),
      ...(applyMode ? { applyMode } : {}),
      ...(notes ? { notes } : {}),
    };
    userWrites.push({ before: keeper.row, userId: keeper.row.user_id, itemKey: keeper.row.item_key, kind: keeper.row.kind, value: JSON.stringify(value) });
    applicationRemaps += 1; applicationMerges += ordered.length - 1;
    for (const item of ordered) applicationIdAliases.set(`${item.row.user_id}\0${item.value.applicationId}`, value.applicationId);
    userDeletes.push(...ordered.slice(1).map((item) => item.row));
  }

  let sessionRemaps = 0;
  for (const row of userRows.filter((item) => item.kind === 'application-session')) {
    const value = parse<ApplicationSession>(row.value);
    const jobId = canonicalByJobId.get(value.jobId) ?? value.jobId;
    const applicationId = applicationIdAliases.get(`${row.user_id}\0${value.applicationId}`) ?? value.applicationId;
    if (jobId === value.jobId && applicationId === value.applicationId) continue;
    sessionRemaps += 1;
    userWrites.push({ before: row, userId: row.user_id, itemKey: row.item_key, kind: row.kind, value: JSON.stringify({ ...value, jobId, applicationId }) });
  }

  let receiptRemaps = 0; let receiptMerges = 0;
  const receiptGroups = new Map<string, Array<{ row: UserRow; value: DeliveryReceipt; itemKey: string }>>();
  for (const row of userRows.filter((item) => item.kind === 'receipt')) {
    const value = parse<DeliveryReceipt>(row.value); const canonical = canonicalByJobId.get(value.jobId);
    const job = canonical && canonicalJobs.get(canonical); if (!canonical || !job) continue;
    const dedupeKey = notificationDedupeKey(job); const itemKey = `RECEIPT#${dedupeKey}#${value.token}`;
    const group = `${row.user_id}\0${itemKey}`;
    receiptGroups.set(group, [...(receiptGroups.get(group) ?? []), { row, value: { ...value, jobId: canonical, dedupeKey }, itemKey }]);
  }
  for (const records of receiptGroups.values()) {
    const ordered = [...records].sort((a, b) => receiptRank(b.value) - receiptRank(a.value) || b.value.updatedAt.localeCompare(a.value.updatedAt));
    const keeper = ordered[0]!; const existingTarget = userRows.find((row) => row.user_id === keeper.row.user_id && row.item_key === keeper.itemKey);
    if (existingTarget && !records.some((item) => item.row === existingTarget)) {
      ordered.push({ row: existingTarget, value: parse<DeliveryReceipt>(existingTarget.value), itemKey: keeper.itemKey });
      ordered.sort((a, b) => receiptRank(b.value) - receiptRank(a.value) || b.value.updatedAt.localeCompare(a.value.updatedAt));
    }
    const strongest = ordered[0]!;
    const strongestJson = JSON.stringify(strongest.value);
    if (!existingTarget || existingTarget.value !== strongestJson) userWrites.push({ before: existingTarget, userId: keeper.row.user_id, itemKey: keeper.itemKey, kind: 'receipt', value: strongestJson, columns: {
      receipt_state: strongest.value.status === 'pending' ? 'PENDING' : strongest.value.status === 'retryable' ? 'RETRYABLE' : null,
      expires_at: keeper.row.expires_at ?? null,
    } });
    const deleted = new Set<string>();
    for (const item of records) if (item.row.item_key !== keeper.itemKey && !deleted.has(item.row.item_key)) { userDeletes.push(item.row); deleted.add(item.row.item_key); }
    if (!existingTarget || existingTarget.value !== strongestJson || deleted.size) receiptRemaps += 1;
    receiptMerges += Math.max(0, ordered.length - 1);
  }

  let releaseRemaps = 0;
  for (const row of userRows.filter((item) => item.kind === 'catalog-release')) {
    const value = parse<CatalogRelease>(row.value);
    const mapIds = (ids: string[]) => [...new Set(ids.map((id) => canonicalByJobId.get(id) ?? id))];
    const next = { ...value, jobIds: mapIds(value.jobIds), newJobIds: mapIds(value.newJobIds) };
    if (JSON.stringify(next) === row.value) continue;
    releaseRemaps += 1; userWrites.push({ before: row, userId: row.user_id, itemKey: row.item_key, kind: row.kind, value: JSON.stringify(next) });
  }

  const proposalUpdates = proposalRows.filter((row) => canonicalByJobId.has(row.job_id) && canonicalByJobId.get(row.job_id) !== row.job_id);
  const uniqueCatalogWrites = new Map<string, CatalogWrite>();
  for (const write of catalogWrites) {
    const key = `${write.pk}\0${write.sk}`;
    const previous = uniqueCatalogWrites.get(key);
    uniqueCatalogWrites.set(key, previous
      ? { ...write, before: previous.before ?? write.before }
      : write);
  }
  catalogWrites.splice(0, catalogWrites.length, ...uniqueCatalogWrites.values());
  const expectedChanges = catalogWrites.length + catalogDeletes.length + userWrites.length + userDeletes.length + proposalUpdates.length;
  const facts = stable({
    catalogWrites: catalogWrites.map((item) => [item.pk, item.sk, item.before?.value ?? null, item.value]),
    catalogDeletes: catalogDeletes.map((item) => [item.pk, item.sk, item.value]),
    userWrites: userWrites.map((item) => [item.userId, item.itemKey, item.before?.value ?? null, item.value]),
    userDeletes: userDeletes.map((item) => [item.user_id, item.item_key, item.value]),
    proposals: proposalUpdates.map((item) => [item.id, item.job_id, canonicalByJobId.get(item.job_id)]),
    presentationDisagreements,
    conflicts: [...conflicts].sort(),
  });
  const repairToken = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return {
    scope, repairToken, providerGroups: groups.size, duplicateGroups, duplicateJobs,
    eligibleDuplicateGroups, eligibleDuplicateJobs,
    unresolvedDuplicateGroups: presentationDisagreements.length,
    jobUpdates: catalogWrites.filter((item) => item.kind === 'internship').length, jobDeletes: catalogDeletes.length,
    aliasWrites: catalogWrites.filter((item) => item.kind === 'posting-alias' || item.kind === 'job-id-alias').length,
    occurrenceRemaps, applicationRemaps, applicationMerges, sessionRemaps, receiptRemaps, receiptMerges,
    releaseRemaps, proposalRemaps: proposalUpdates.length,
    outboxRows: catalogRows.filter((row) => row.kind === 'notification-event').length,
    conflicts: [...conflicts].sort(), presentationDisagreements, samples: samples.slice(0, 20), expectedChanges,
    applied: false, projectionRefreshRequired: false,
    catalogWrites, catalogDeletes, userWrites, userDeletes, proposalUpdates,
  };
}

const STAGE_KIND = 'posting-identity-repair-stage';
const STAGE_ROWS_PER_STATEMENT = 20;
const D1_PAID_QUERY_LIMIT = 1_000;
const POST_REPAIR_QUERY_RESERVE = 100;
function operationId(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/**
 * Conservative statement budget for the repair itself. Twenty staged rows use
 * D1's full 100-bound-parameter allowance; the remaining statements are the
 * three snapshot reads, stage reset, guard plus mutations, and stage cleanup.
 * The endpoint keeps a reserve for verification and projection refresh.
 */
export function postingIdentityRepairQueryCount(expectedChanges: number) {
  return expectedChanges + Math.ceil(expectedChanges / STAGE_ROWS_PER_STATEMENT) + 6;
}

async function stage(db: D1Database, plan: InternalPlan) {
  const pk = `POSTING_IDENTITY_REPAIR#${plan.repairToken}`;
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}'`).bind(pk).run();
  const values = [
    ...plan.catalogWrites.map((item) => ({ table: 'catalog', key1: item.pk, key2: item.sk, old: item.before?.value ?? null })),
    ...plan.catalogDeletes.map((item) => ({ table: 'catalog', key1: item.pk, key2: item.sk, old: item.value })),
    ...plan.userWrites.map((item) => ({ table: 'user', key1: item.userId, key2: item.itemKey, old: item.before?.value ?? null })),
    ...plan.userDeletes.map((item) => ({ table: 'user', key1: item.user_id, key2: item.item_key, old: item.value })),
    ...plan.proposalUpdates.map((item) => ({ table: 'proposal', key1: item.id, key2: '', old: item.job_id })),
  ];
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < values.length; offset += STAGE_ROWS_PER_STATEMENT) {
    const chunk = values.slice(offset, offset + STAGE_ROWS_PER_STATEMENT);
    const placeholders = chunk.map(() => `(?, ?, '${STAGE_KIND}', ?, ?, ?)`).join(', ');
    statements.push(db.prepare(
      `INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id) VALUES ${placeholders}`,
    ).bind(...chunk.flatMap((item) => [pk, operationId(item), JSON.stringify(item), item.key1, item.key2])));
  }
  for (let offset = 0; offset < statements.length; offset += 50) await db.batch(statements.slice(offset, offset + 50));
  return pk;
}

function guardClause() { return "EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = 'GUARD' AND kind = 'posting-identity-repair-guard')"; }

function repairReport(plan: InternalPlan): PostingIdentityRepairPlan {
  return {
    scope: plan.scope, repairToken: plan.repairToken, providerGroups: plan.providerGroups, duplicateGroups: plan.duplicateGroups,
    duplicateJobs: plan.duplicateJobs, eligibleDuplicateGroups: plan.eligibleDuplicateGroups,
    eligibleDuplicateJobs: plan.eligibleDuplicateJobs, unresolvedDuplicateGroups: plan.unresolvedDuplicateGroups,
    jobUpdates: plan.jobUpdates, jobDeletes: plan.jobDeletes,
    aliasWrites: plan.aliasWrites, occurrenceRemaps: plan.occurrenceRemaps, applicationRemaps: plan.applicationRemaps,
    applicationMerges: plan.applicationMerges, sessionRemaps: plan.sessionRemaps, receiptRemaps: plan.receiptRemaps,
    receiptMerges: plan.receiptMerges, releaseRemaps: plan.releaseRemaps, proposalRemaps: plan.proposalRemaps,
    outboxRows: plan.outboxRows, conflicts: plan.conflicts, presentationDisagreements: plan.presentationDisagreements,
    samples: plan.samples, expectedChanges: plan.expectedChanges,
    applied: plan.applied, projectionRefreshRequired: plan.projectionRefreshRequired,
  };
}

function catalogWriteStatement(db: D1Database, stagePk: string, item: CatalogWrite): D1PreparedStatement {
  const columns = item.columns ?? {};
  if (item.before) return db.prepare(`UPDATE catalog_items SET kind = ?, value = ?, url_key = ?, fingerprint_key = ?, sms_pending = ?, digest_pending = ?, catalog_state = ?, catalog_sort_key = ?, search_text = ?, source_classes = ? WHERE pk = ? AND sk = ? AND ${guardClause()}`)
    .bind(item.kind, item.value, columns.url_key ?? item.before.url_key ?? null, columns.fingerprint_key ?? item.before.fingerprint_key ?? null,
      columns.sms_pending ?? item.before.sms_pending ?? 0, columns.digest_pending ?? item.before.digest_pending ?? 0,
      columns.catalog_state ?? item.before.catalog_state ?? null, columns.catalog_sort_key ?? item.before.catalog_sort_key ?? null,
      columns.search_text ?? item.before.search_text ?? null, columns.source_classes ?? item.before.source_classes ?? null,
      item.pk, item.sk, stagePk);
  return db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value) SELECT ?, ?, ?, ? WHERE ${guardClause()}`)
    .bind(item.pk, item.sk, item.kind, item.value, stagePk);
}

export async function runPostingIdentityRepair(db: D1Database, options: {
  apply?: boolean;
  repairToken?: string;
  expectedChanges?: number;
  expectedDuplicateJobs?: number;
  scope?: PostingIdentityRepairScope;
} = {}): Promise<PostingIdentityRepairPlan> {
  const [catalog, users, proposals] = await Promise.all([
    db.prepare('SELECT * FROM catalog_items ORDER BY pk, sk').all<CatalogRow>(),
    db.prepare('SELECT * FROM user_items ORDER BY user_id, item_key').all<UserRow>(),
    db.prepare('SELECT id, job_id FROM employer_field_proposals ORDER BY id').all<ProposalRow>(),
  ]);
  const scope = options.scope ?? 'all';
  if (!['all', 'identity', 'occurrences'].includes(scope)) throw new Error('Posting identity repair scope must be all, identity, or occurrences');
  const plan = postingIdentityRepairPlan(catalog.results, users.results, proposals.results, scope);
  const report = repairReport(plan);
  if (scope === 'occurrences' && plan.duplicateJobs > 0) {
    return { ...report, conflicts: [...report.conflicts, 'Apply and verify the identity scope before occurrence synchronization'] };
  }
  if (!options.apply) return report;
  if (plan.conflicts.length) throw new Error('Refusing apply while posting identity conflicts remain');
  if (plan.presentationDisagreements.length) {
    throw new Error('Refusing apply while duplicate groups have unresolved presentation disagreements');
  }
  if (options.repairToken !== plan.repairToken || options.expectedChanges !== plan.expectedChanges || options.expectedDuplicateJobs !== plan.duplicateJobs) {
    throw new Error('Catalog changed after dry run; use its exact repair token, changed-record count, and duplicate-job count');
  }
  if (!plan.expectedChanges) return { ...report, applied: true };
  if (postingIdentityRepairQueryCount(plan.expectedChanges) > D1_PAID_QUERY_LIMIT - POST_REPAIR_QUERY_RESERVE) {
    throw new Error('Posting identity repair exceeds the guarded D1 query budget; split the reviewed repair plan');
  }
  const stagePk = await stage(db, plan);
  const guard = db.prepare(`
    INSERT INTO catalog_items (pk, sk, kind, value)
    SELECT ?, 'GUARD', 'posting-identity-repair-guard', ?
    WHERE (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}') = ?
      AND (SELECT COUNT(*) FROM catalog_items AS staged LEFT JOIN catalog_items AS current
        ON json_extract(staged.value, '$.table') = 'catalog' AND current.pk = staged.source_id AND current.sk = staged.external_id
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}' AND json_extract(staged.value, '$.table') = 'catalog'
          AND ((json_extract(staged.value, '$.old') IS NULL AND current.pk IS NULL) OR current.value = json_extract(staged.value, '$.old'))) =
          (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}' AND json_extract(value, '$.table') = 'catalog')
      AND (SELECT COUNT(*) FROM catalog_items AS staged LEFT JOIN user_items AS current
        ON json_extract(staged.value, '$.table') = 'user' AND current.user_id = staged.source_id AND current.item_key = staged.external_id
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}' AND json_extract(staged.value, '$.table') = 'user'
          AND ((json_extract(staged.value, '$.old') IS NULL AND current.user_id IS NULL) OR current.value = json_extract(staged.value, '$.old'))) =
          (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}' AND json_extract(value, '$.table') = 'user')
      AND (SELECT COUNT(*) FROM catalog_items AS staged JOIN employer_field_proposals AS current ON current.id = staged.source_id
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}' AND json_extract(staged.value, '$.table') = 'proposal' AND current.job_id = json_extract(staged.value, '$.old')) =
          (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}' AND json_extract(value, '$.table') = 'proposal')
  `).bind(stagePk, JSON.stringify({ repairToken: plan.repairToken }), stagePk, plan.expectedChanges, stagePk, stagePk, stagePk, stagePk, stagePk, stagePk);
  const statements: D1PreparedStatement[] = [guard];
  statements.push(...plan.catalogWrites.map((item) => catalogWriteStatement(db, stagePk, item)));
  statements.push(...plan.catalogDeletes.map((item) => db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND sk = ? AND ${guardClause()}`).bind(item.pk, item.sk, stagePk)));
  statements.push(...plan.userWrites.map((item) => item.before
    ? db.prepare(`UPDATE user_items SET kind = ?, value = ?, receipt_state = ?, expires_at = ? WHERE user_id = ? AND item_key = ? AND ${guardClause()}`)
      .bind(item.kind, item.value, item.columns?.receipt_state ?? item.before!.receipt_state ?? null, item.columns?.expires_at ?? item.before!.expires_at ?? null, item.userId, item.itemKey, stagePk)
    : db.prepare(`INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guardClause()}`)
      .bind(item.userId, item.itemKey, item.kind, item.value, item.columns?.receipt_state ?? null, item.columns?.expires_at ?? null, stagePk)));
  statements.push(...plan.userDeletes.map((item) => db.prepare(`DELETE FROM user_items WHERE user_id = ? AND item_key = ? AND ${guardClause()}`).bind(item.user_id, item.item_key, stagePk)));
  statements.push(...plan.proposalUpdates.map((item) => db.prepare(`UPDATE employer_field_proposals SET job_id = ? WHERE id = ? AND ${guardClause()}`).bind(canonicalJobId(plan, item.job_id), item.id, stagePk)));
  const results = await db.batch(statements);
  const guarded = results[0]?.meta.changes === 1;
  const changed = results.slice(1).reduce((total, item) => total + item.meta.changes, 0);
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind IN ('${STAGE_KIND}', 'posting-identity-repair-guard')`).bind(stagePk).run();
  if (!guarded || changed !== plan.expectedChanges) throw new Error('Posting identity repair conflict; no guarded changes were accepted');
  return { ...report, applied: true, projectionRefreshRequired: true };
}

function canonicalJobId(plan: InternalPlan, oldJobId: string) {
  const alias = plan.catalogWrites.find((item) => item.kind === 'job-id-alias' && item.pk === `JOB_ID_ALIAS#${oldJobId}`);
  return alias ? parse<{ canonicalJobId: string }>(alias.value).canonicalJobId : oldJobId;
}
