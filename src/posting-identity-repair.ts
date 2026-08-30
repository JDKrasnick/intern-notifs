import { createHash } from 'node:crypto';
import type { ApplicationSession } from './application-automation.js';
import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { inferSeason } from './core/early-career.js';
import { fingerprint, normalizeUrl } from './core/normalize.js';
import { canonicalizePostingUrl } from './identity/posting.js';
import { resolvePostingIdentityDecision, type PostingIdentityRegistryResult } from './identity/registry.js';
import {
  providerEvidenceForOccurrence,
  reviewedProviderEvidenceError,
  reviewedProviderUrlReference,
  uniqueGreenhouseEvidenceForSources,
  unscopedGreenhouseEmbedPostingId,
} from './identity/reviewed-provider.js';
import { notificationDedupeKey } from './notifications.js';
import type { CatalogRelease } from './catalog-groups.js';
import { isOfficialOccurrence } from './sources/provenance.js';
import type { ApplicationRecord, DeliveryReceipt, Internship, PostingIdentity, PostingProvider, ProviderPostingEvidence, SourceCheckpoint, SourceOccurrence } from './types.js';
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

export interface PostingIdentityRepairPlan {
  schemaVersion: 2;
  scope: PostingIdentityRepairScope;
  snapshotDigest: string;
  repairToken: string;
  occurrenceCounts: {
    confirmed: number;
    unconfirmed: number;
    legacy: number;
    quarantined: number;
    /** Legacy-unclassified rows are excluded from this denominator. */
    confirmedCoverage: number | null;
  };
  duplicateAlertGroups: number;
  unknownUrlFamilyCandidates: Array<{ reviewFamilyKey: string; occurrences: number }>;
  gate: {
    passed: boolean;
    exactDuplicateGroups: number;
    aliasConflicts: number;
    untrackedQuarantines: number;
    presentationBlockers: number;
    legacyOccurrences: number;
  };
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
  notificationTombstoneRemaps: number;
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

function mergeJob(
  canonical: Internship,
  members: Internship[],
  identity: PostingIdentity,
  official: SourceOccurrence | undefined,
  classify: (reference: SourceOccurrence, fallbackObservedAt: string) => SourceOccurrence,
): Internship {
  const sourceReferences = [...new Map(members.flatMap((job) => job.sourceReferences).map((item) => [occurrenceKey(item), item])).values()]
    .map((reference) => classify(reference, canonical.firstSeenAt));
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
    postingIdentityStatus: 'confirmed',
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

type HistoricalProviderEvidence = {
  provider: Exclude<PostingProvider, 'unknown'>;
  tenant?: string;
  postingId: string;
  sourceId: string;
  identity: PostingIdentity;
};

function providerKey(evidence: Pick<HistoricalProviderEvidence, 'provider' | 'tenant' | 'postingId'>) {
  return `${evidence.provider}:${evidence.tenant?.toLowerCase() ?? '-'}:${evidence.postingId.toLowerCase()}`;
}

function checkpointEvidenceForUnscopedGreenhouseEmbed(
  input: string,
  checkpoints: Map<string, SourceCheckpoint>,
): ProviderPostingEvidence | undefined {
  const postingId = unscopedGreenhouseEmbedPostingId(input);
  if (!postingId) return undefined;
  const activeSources = [...checkpoints.entries()]
    .filter(([, checkpoint]) => checkpoint.activeExternalIds?.includes(postingId))
    .map(([sourceId]) => sourceId);
  return uniqueGreenhouseEvidenceForSources(postingId, activeSources, [input]);
}

function historicalOccurrenceDecision(
  occurrence: SourceOccurrence,
  checkpoints: Map<string, SourceCheckpoint>,
  fallbackObservedAt: string,
): { occurrence: SourceOccurrence; result: PostingIdentityRegistryResult; evidenceSourceId?: string } {
  const normalized = withProviderEvidence(occurrence);
  const embedded = checkpointEvidenceForUnscopedGreenhouseEmbed(normalized.applyUrl, checkpoints);
  const providerEvidence = normalized.providerEvidence ?? embedded;
  const parsed = reviewedProviderUrlReference(normalized.applyUrl);
  const reviewedProviderReferences = parsed.outcome === 'match'
    && checkpoints.get(parsed.reference.sourceId)?.activeExternalIds?.includes(parsed.reference.postingId)
    ? [{ provider: parsed.reference.provider, tenant: parsed.reference.tenant, postingId: parsed.reference.postingId }]
    : [];
  const result = resolvePostingIdentityDecision({
    sourceId: normalized.sourceId,
    externalId: normalized.externalId ?? '',
    applicationUrl: normalized.applyUrl,
    observedAt: normalized.postingIdentityDecision?.observedAt ?? normalized.firstAttachedAt ?? fallbackObservedAt,
    ...(providerEvidence ? { providerEvidence } : {}),
    ...(reviewedProviderReferences.length ? { reviewedProviderReferences } : {}),
    ...(normalized.postingIdentityDecision ? { previousDecision: normalized.postingIdentityDecision } : {}),
  });
  return {
    occurrence: providerEvidence ? { ...normalized, providerEvidence } : normalized,
    result,
    ...(providerEvidence?.sourceId
      ? { evidenceSourceId: providerEvidence.sourceId }
      : parsed.outcome === 'match' && reviewedProviderReferences.length
        ? { evidenceSourceId: parsed.reference.sourceId }
        : {}),
  };
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
function officialPresentation(members: Internship[], evidence: HistoricalProviderEvidence): SourceOccurrence | undefined {
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
  const snapshotDigest = createHash('sha256').update(JSON.stringify(stable({
    catalog: catalogRows.map((row) => [row.pk, row.sk, row.kind, row.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1]))),
    users: userRows.map((row) => [row.user_id, row.item_key, row.kind, row.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1]))),
    proposals: proposalRows.map((row) => [row.id, row.job_id])
      .sort((left, right) => left[0].localeCompare(right[0])),
  }))).digest('hex');
  const occurrenceDecisions = new Map<string, SourceOccurrence['postingIdentityDecision']>();
  let untrackedQuarantines = 0;
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const state = parse<{ sourceId: string; externalId: string; occurrence: SourceOccurrence }>(row.value);
      occurrenceDecisions.set(occurrenceKey(state.occurrence), state.occurrence.postingIdentityDecision);
      if (state.occurrence.postingIdentityDecision?.status === 'quarantined') untrackedQuarantines += 1;
    } catch { /* The existing occurrence parser reports malformed rows below. */ }
  }
  for (const row of catalogRows.filter((item) => item.kind === 'internship')) {
    try {
      const job = parse<Internship>(row.value);
      for (const occurrence of job.sourceReferences) {
        occurrenceDecisions.set(occurrenceKey(occurrence), occurrenceDecisions.get(occurrenceKey(occurrence)) ?? occurrence.postingIdentityDecision);
      }
    } catch { /* The primary job scan reports malformed rows below. */ }
  }
  const decisionValues = [...occurrenceDecisions.values()];
  const confirmedOccurrences = decisionValues.filter((decision) => decision?.status === 'confirmed').length;
  const unconfirmedOccurrences = decisionValues.filter((decision) => decision?.status === 'unconfirmed').length;
  const incidentCount = catalogRows.filter((row) => row.kind === 'posting-identity-incident').length;
  const legacyOccurrences = decisionValues.filter((decision) => !decision).length;
  const classifiedOccurrences = confirmedOccurrences + unconfirmedOccurrences;
  const familyCounts = new Map<string, number>();
  for (const decision of decisionValues) if (decision?.status === 'unconfirmed') {
    familyCounts.set(decision.reviewFamilyKey, (familyCounts.get(decision.reviewFamilyKey) ?? 0) + 1);
  }
  const checkpoints = new Map(catalogRows.filter((row) => row.kind === 'checkpoint').flatMap((row) => {
    try { const value = parse<SourceCheckpoint>(row.value); return [[value.sourceId, value] as const]; } catch { return []; }
  }));
  const occurrencesByJob = new Map<string, SourceOccurrence[]>();
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const state = parse<{ jobId: string; occurrence: SourceOccurrence; firstObservedAt?: string; firstObservedAtPrecision?: 'exact' | 'unknown'; changedAt?: string }>(row.value);
      const attachedAt = state.firstObservedAt ?? state.changedAt;
      const occurrence = attachedAt && !state.occurrence.firstAttachedAt
        ? { ...state.occurrence, firstAttachedAt: attachedAt, firstAttachedAtPrecision: state.firstObservedAt ? state.firstObservedAtPrecision ?? 'exact' as const : 'unknown' as const }
        : state.occurrence;
      occurrencesByJob.set(state.jobId, [...(occurrencesByJob.get(state.jobId) ?? []), occurrence]);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed source occurrence JSON`); }
  }
  const jobRows = catalogRows.filter((row) => row.kind === 'internship');
  const catalogByKey = new Map(catalogRows.map((row) => [`${row.pk}\0${row.sk}`, row]));
  const classificationByOccurrence = new Map<string, { occurrence: SourceOccurrence; result: PostingIdentityRegistryResult; evidenceSourceId?: string }>();
  const classifyResult = (occurrence: SourceOccurrence, fallbackObservedAt: string) => {
    const key = occurrenceKey(occurrence);
    const existing = classificationByOccurrence.get(key);
    if (existing) return existing;
    const classified = historicalOccurrenceDecision(occurrence, checkpoints, fallbackObservedAt);
    classificationByOccurrence.set(key, classified);
    return classified;
  };
  const classifiedOccurrence = (occurrence: SourceOccurrence, fallbackObservedAt: string) => {
    const classified = classifyResult(occurrence, fallbackObservedAt);
    return { ...classified.occurrence, postingIdentityDecision: classified.result.decision };
  };
  const groups = new Map<string, Array<{ row: CatalogRow; job: Internship; evidence: HistoricalProviderEvidence }>>();
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
    const evidence = job.sourceReferences.flatMap((reference): HistoricalProviderEvidence[] => {
      const classified = classifyResult(reference, job.firstSeenAt);
      if (classified.result.decision.status === 'quarantined') {
        conflicts.push(`${job.jobId}:${reference.sourceId}: ${classified.result.decision.reason}`);
        return [];
      }
      const identity = classified.result.identity;
      if (classified.result.decision.status !== 'confirmed' || !identity
        || identity.provider === 'unknown' || !identity.providerPostingId) return [];
      return [{
        provider: identity.provider,
        ...(identity.tenant ? { tenant: identity.tenant } : {}),
        postingId: identity.providerPostingId,
        sourceId: classified.evidenceSourceId ?? reference.sourceId,
        identity,
      }];
    });
    const uniqueEvidence = [...new Map(evidence.map((item) => [providerKey(item), item])).values()];
    if (uniqueEvidence.length > 1) { conflicts.push(`${job.jobId}: reviewed provider evidence disagrees (${uniqueEvidence.map(providerKey).sort().join(', ')})`); continue; }
    if (!uniqueEvidence.length) continue;
    const key = providerKey(uniqueEvidence[0]!);
    groups.set(key, [...(groups.get(key) ?? []), { row, job, evidence: uniqueEvidence[0]! }]);
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
    const retainedIdentity = ordered.length === 1
      && canonical.job.postingIdentity?.provider === canonical.evidence.provider
      && canonical.job.postingIdentity.tenant?.toLowerCase() === canonical.evidence.tenant?.toLowerCase()
      && canonical.job.postingIdentity.providerPostingId?.toLowerCase() === canonical.evidence.postingId.toLowerCase()
      ? canonical.job.postingIdentity
      : undefined;
    const identity = retainedIdentity
      ? { ...retainedIdentity }
      : {
          ...canonical.evidence.identity,
          canonicalApplicationUrl: canonicalizePostingUrl(canonical.job.applyUrl),
          aliases: [...canonical.evidence.identity.aliases],
        };
    identity.canonicalJobId = canonical.job.jobId;
    const classifyReference = scope === 'identity'
      ? (reference: SourceOccurrence) => reference
      : classifiedOccurrence;
    const merged = retainedIdentity
      ? { ...canonical.job, postingIdentityStatus: 'confirmed' as const,
          sourceReferences: canonical.job.sourceReferences.map((reference) => classifyReference(reference, canonical.job.firstSeenAt)) }
      : mergeJob(canonical.job, ordered.map((item) => item.job), identity, official, classifyReference);
    canonicalJobs.set(canonical.job.jobId, merged);
    for (const item of ordered) canonicalByJobId.set(item.job.jobId, canonical.job.jobId);
    if (scope === 'occurrences') continue;
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
    const sourceReferences = mergedOccurrenceEvidence([...base.sourceReferences, ...occurrenceReferences])
      .map((reference) => classifiedOccurrence(reference, base.firstSeenAt));
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

  }

  let occurrenceRemaps = 0;
  if (scope !== 'identity') for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const value = parse<{ jobId: string; occurrence: SourceOccurrence; firstObservedAt?: string; changedAt?: string }>(row.value);
      const canonical = canonicalByJobId.get(value.jobId) ?? value.jobId;
      const remapped = canonical !== value.jobId;
      const normalizedOccurrence = remapped ? withProviderEvidence(value.occurrence) : normalizedOccurrenceSeason(value.occurrence);
      const occurrence = classifiedOccurrence(
        normalizedOccurrence,
        value.firstObservedAt ?? value.changedAt ?? canonicalJobs.get(canonical)?.firstSeenAt ?? '1970-01-01T00:00:00.000Z',
      );
      const normalized = JSON.stringify(stable(occurrence)) !== JSON.stringify(stable(value.occurrence));
      if (!remapped && !normalized) continue;
      if (remapped) occurrenceRemaps += 1;
      catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind, value: JSON.stringify({
        ...value, jobId: canonical, occurrence,
      }) });
    } catch { /* Malformed occurrence JSON was reported while building reviewed evidence. */ }
  }

  let notificationTombstoneRemaps = 0;
  const notificationTombstoneGroups = new Map<string, CatalogRow[]>();
  for (const row of catalogRows.filter((item) => item.kind === 'notification-tombstone')) {
    try {
      const value = parse<{ jobId?: string }>(row.value);
      if (!value.jobId) continue;
      const canonical = canonicalByJobId.get(value.jobId);
      if (!canonical || canonical === value.jobId) continue;
      const target = `${row.pk}\0ROLE#${canonical}`;
      notificationTombstoneGroups.set(target, [...(notificationTombstoneGroups.get(target) ?? []), row]);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed notification tombstone JSON`); }
  }
  for (const [target, rows] of notificationTombstoneGroups) {
    const [pk, sk] = target.split('\0');
    const canonicalJobId = sk!.slice('ROLE#'.length);
    const existing = catalogByKey.get(target);
    const candidates = [...rows, ...(existing && !rows.includes(existing) ? [existing] : [])];
    const retained = [...candidates].sort((left, right) => {
      const leftAt = (() => { try { return parse<{ deletedAt?: string }>(left.value).deletedAt ?? ''; } catch { return ''; } })();
      const rightAt = (() => { try { return parse<{ deletedAt?: string }>(right.value).deletedAt ?? ''; } catch { return ''; } })();
      return leftAt.localeCompare(rightAt) || left.sk.localeCompare(right.sk);
    })[0]!;
    const value = JSON.stringify({ ...parse<Record<string, unknown>>(retained.value), jobId: canonicalJobId });
    if (!existing || existing.value !== value) catalogWrites.push({ before: existing, pk: pk!, sk: sk!, kind: 'notification-tombstone', value });
    for (const row of rows) if (row.pk !== pk || row.sk !== sk) catalogDeletes.push(row);
    notificationTombstoneRemaps += rows.filter((row) => row.pk !== pk || row.sk !== sk).length;
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
  const notificationGroups = new Map<string, number>();
  for (const row of catalogRows.filter((item) => item.kind === 'notification-event')) {
    try {
      const event = parse<{ jobId: string }>(row.value);
      const canonicalId = canonicalByJobId.get(event.jobId) ?? event.jobId;
      notificationGroups.set(canonicalId, (notificationGroups.get(canonicalId) ?? 0) + 1);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed notification event JSON`); }
  }
  const duplicateAlertGroups = [...notificationGroups.values()].filter((count) => count > 1).length;
  const sortedConflicts = [...conflicts].sort();
  const gate = {
    passed: eligibleDuplicateGroups === 0 && sortedConflicts.length === 0 && untrackedQuarantines === 0
      && presentationDisagreements.length === 0 && duplicateAlertGroups === 0 && legacyOccurrences === 0,
    exactDuplicateGroups: eligibleDuplicateGroups,
    aliasConflicts: sortedConflicts.length,
    untrackedQuarantines,
    presentationBlockers: presentationDisagreements.length,
    legacyOccurrences,
  };
  return {
    schemaVersion: 2, scope, snapshotDigest, repairToken,
    occurrenceCounts: {
      confirmed: confirmedOccurrences, unconfirmed: unconfirmedOccurrences, legacy: legacyOccurrences,
      quarantined: incidentCount,
      confirmedCoverage: classifiedOccurrences ? confirmedOccurrences / classifiedOccurrences : null,
    },
    duplicateAlertGroups,
    unknownUrlFamilyCandidates: [...familyCounts.entries()].filter(([, count]) => count > 1)
      .map(([reviewFamilyKey, occurrences]) => ({ reviewFamilyKey, occurrences }))
      .sort((left, right) => right.occurrences - left.occurrences || left.reviewFamilyKey.localeCompare(right.reviewFamilyKey)),
    gate,
    providerGroups: groups.size, duplicateGroups, duplicateJobs,
    eligibleDuplicateGroups, eligibleDuplicateJobs,
    unresolvedDuplicateGroups: presentationDisagreements.length,
    jobUpdates: catalogWrites.filter((item) => item.kind === 'internship').length, jobDeletes: catalogDeletes.length,
    aliasWrites: catalogWrites.filter((item) => item.kind === 'posting-alias' || item.kind === 'job-id-alias').length,
    occurrenceRemaps, notificationTombstoneRemaps, applicationRemaps, applicationMerges, sessionRemaps, receiptRemaps, receiptMerges,
    releaseRemaps, proposalRemaps: proposalUpdates.length,
    outboxRows: catalogRows.filter((row) => row.kind === 'notification-event').length,
    conflicts: sortedConflicts, presentationDisagreements, samples: samples.slice(0, 20), expectedChanges,
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
 * D1's full 100-bound-parameter allowance. Mutations are then applied with
 * seven guarded set-based statements rather than one statement per row.
 */
export function postingIdentityRepairQueryCount(expectedChanges: number) {
  return Math.ceil(expectedChanges / STAGE_ROWS_PER_STATEMENT) + 13;
}

async function stage(db: D1Database, plan: InternalPlan) {
  const pk = `POSTING_IDENTITY_REPAIR#${plan.repairToken}`;
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}'`).bind(pk).run();
  const values = [
    ...plan.catalogWrites.map((item) => ({
      table: 'catalog', action: 'write', key1: item.pk, key2: item.sk,
      old: item.before?.value ?? null, kind: item.kind, new: item.value,
      columns: {
        url_key: item.columns?.url_key ?? item.before?.url_key ?? null,
        fingerprint_key: item.columns?.fingerprint_key ?? item.before?.fingerprint_key ?? null,
        sms_pending: item.columns?.sms_pending ?? item.before?.sms_pending ?? 0,
        digest_pending: item.columns?.digest_pending ?? item.before?.digest_pending ?? 0,
        catalog_state: item.columns?.catalog_state ?? item.before?.catalog_state ?? null,
        catalog_sort_key: item.columns?.catalog_sort_key ?? item.before?.catalog_sort_key ?? null,
        search_text: item.columns?.search_text ?? item.before?.search_text ?? null,
        source_classes: item.columns?.source_classes ?? item.before?.source_classes ?? null,
      },
    })),
    ...plan.catalogDeletes.map((item) => ({ table: 'catalog', action: 'delete', key1: item.pk, key2: item.sk, old: item.value })),
    ...plan.userWrites.map((item) => ({
      table: 'user', action: 'write', key1: item.userId, key2: item.itemKey,
      old: item.before?.value ?? null, kind: item.kind, new: item.value,
      columns: {
        receipt_state: item.columns?.receipt_state ?? item.before?.receipt_state ?? null,
        expires_at: item.columns?.expires_at ?? item.before?.expires_at ?? null,
      },
    })),
    ...plan.userDeletes.map((item) => ({ table: 'user', action: 'delete', key1: item.user_id, key2: item.item_key, old: item.value })),
    ...plan.proposalUpdates.map((item) => ({
      table: 'proposal', action: 'write', key1: item.id, key2: '', old: item.job_id,
      new: canonicalJobId(plan, item.job_id),
    })),
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
    schemaVersion: plan.schemaVersion, scope: plan.scope, snapshotDigest: plan.snapshotDigest,
    repairToken: plan.repairToken, occurrenceCounts: plan.occurrenceCounts,
    duplicateAlertGroups: plan.duplicateAlertGroups, unknownUrlFamilyCandidates: plan.unknownUrlFamilyCandidates, gate: plan.gate,
    providerGroups: plan.providerGroups, duplicateGroups: plan.duplicateGroups,
    duplicateJobs: plan.duplicateJobs, eligibleDuplicateGroups: plan.eligibleDuplicateGroups,
    eligibleDuplicateJobs: plan.eligibleDuplicateJobs, unresolvedDuplicateGroups: plan.unresolvedDuplicateGroups,
    jobUpdates: plan.jobUpdates, jobDeletes: plan.jobDeletes,
    aliasWrites: plan.aliasWrites, occurrenceRemaps: plan.occurrenceRemaps,
    notificationTombstoneRemaps: plan.notificationTombstoneRemaps, applicationRemaps: plan.applicationRemaps,
    applicationMerges: plan.applicationMerges, sessionRemaps: plan.sessionRemaps, receiptRemaps: plan.receiptRemaps,
    receiptMerges: plan.receiptMerges, releaseRemaps: plan.releaseRemaps, proposalRemaps: plan.proposalRemaps,
    outboxRows: plan.outboxRows, conflicts: plan.conflicts, presentationDisagreements: plan.presentationDisagreements,
    samples: plan.samples, expectedChanges: plan.expectedChanges,
    applied: plan.applied, projectionRefreshRequired: plan.projectionRefreshRequired,
  };
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
  const statements: D1PreparedStatement[] = [
    guard,
    db.prepare(`
      UPDATE catalog_items AS current SET
        kind = json_extract(staged.value, '$.kind'), value = json_extract(staged.value, '$.new'),
        url_key = json_extract(staged.value, '$.columns.url_key'),
        fingerprint_key = json_extract(staged.value, '$.columns.fingerprint_key'),
        sms_pending = json_extract(staged.value, '$.columns.sms_pending'),
        digest_pending = json_extract(staged.value, '$.columns.digest_pending'),
        catalog_state = json_extract(staged.value, '$.columns.catalog_state'),
        catalog_sort_key = json_extract(staged.value, '$.columns.catalog_sort_key'),
        search_text = json_extract(staged.value, '$.columns.search_text'),
        source_classes = json_extract(staged.value, '$.columns.source_classes')
      FROM catalog_items AS staged
      WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
        AND json_extract(staged.value, '$.table') = 'catalog'
        AND json_extract(staged.value, '$.action') = 'write'
        AND json_extract(staged.value, '$.old') IS NOT NULL
        AND current.pk = staged.source_id AND current.sk = staged.external_id
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      INSERT INTO catalog_items (
        pk, sk, kind, value, url_key, fingerprint_key, sms_pending, digest_pending,
        catalog_state, catalog_sort_key, search_text, source_classes
      )
      SELECT source_id, external_id, json_extract(value, '$.kind'), json_extract(value, '$.new'),
        json_extract(value, '$.columns.url_key'), json_extract(value, '$.columns.fingerprint_key'),
        json_extract(value, '$.columns.sms_pending'), json_extract(value, '$.columns.digest_pending'),
        json_extract(value, '$.columns.catalog_state'), json_extract(value, '$.columns.catalog_sort_key'),
        json_extract(value, '$.columns.search_text'), json_extract(value, '$.columns.source_classes')
      FROM catalog_items
      WHERE pk = ? AND kind = '${STAGE_KIND}'
        AND json_extract(value, '$.table') = 'catalog'
        AND json_extract(value, '$.action') = 'write'
        AND json_extract(value, '$.old') IS NULL
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      DELETE FROM catalog_items AS current
      WHERE EXISTS (
        SELECT 1 FROM catalog_items AS staged
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
          AND json_extract(staged.value, '$.table') = 'catalog'
          AND json_extract(staged.value, '$.action') = 'delete'
          AND current.pk = staged.source_id AND current.sk = staged.external_id
      ) AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      UPDATE user_items AS current SET
        kind = json_extract(staged.value, '$.kind'), value = json_extract(staged.value, '$.new'),
        receipt_state = json_extract(staged.value, '$.columns.receipt_state'),
        expires_at = json_extract(staged.value, '$.columns.expires_at')
      FROM catalog_items AS staged
      WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
        AND json_extract(staged.value, '$.table') = 'user'
        AND json_extract(staged.value, '$.action') = 'write'
        AND json_extract(staged.value, '$.old') IS NOT NULL
        AND current.user_id = staged.source_id AND current.item_key = staged.external_id
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at)
      SELECT source_id, external_id, json_extract(value, '$.kind'), json_extract(value, '$.new'),
        json_extract(value, '$.columns.receipt_state'), json_extract(value, '$.columns.expires_at')
      FROM catalog_items
      WHERE pk = ? AND kind = '${STAGE_KIND}'
        AND json_extract(value, '$.table') = 'user'
        AND json_extract(value, '$.action') = 'write'
        AND json_extract(value, '$.old') IS NULL
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      DELETE FROM user_items AS current
      WHERE EXISTS (
        SELECT 1 FROM catalog_items AS staged
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
          AND json_extract(staged.value, '$.table') = 'user'
          AND json_extract(staged.value, '$.action') = 'delete'
          AND current.user_id = staged.source_id AND current.item_key = staged.external_id
      ) AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      UPDATE employer_field_proposals AS current
      SET job_id = json_extract(staged.value, '$.new')
      FROM catalog_items AS staged
      WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
        AND json_extract(staged.value, '$.table') = 'proposal'
        AND current.id = staged.source_id
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
  ];
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
