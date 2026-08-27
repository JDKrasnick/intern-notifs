import { createHash } from 'node:crypto';
import type { ApplicationSession } from './application-automation.js';
import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { buildPostingIdentity, canonicalizePostingUrl } from './identity/posting.js';
import { providerEvidenceForOccurrence, reviewedProviderEvidenceError, reviewedProviderUrlReference } from './identity/reviewed-provider.js';
import { notificationDedupeKey } from './notifications.js';
import type { CatalogRelease } from './catalog-groups.js';
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

export interface PostingIdentityRepairPlan {
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

function mergeJob(canonical: Internship, members: Internship[], identity: PostingIdentity): Internship {
  const sourceReferences = [...new Map(members.flatMap((job) => job.sourceReferences).map((item) => [occurrenceKey(item), item])).values()];
  const smsSentAt = members.map((job) => job.notification.smsSentAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const digestedAt = members.map((job) => job.notification.digestedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  return {
    ...canonical,
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

function evidenceForJob(job: Internship, checkpoints: Map<string, SourceCheckpoint>): ProviderPostingEvidence[] {
  const result: ProviderPostingEvidence[] = [];
  for (const occurrence of job.sourceReferences) {
    const direct = occurrence.providerEvidence
      ?? (occurrence.externalId ? providerEvidenceForOccurrence(occurrence.sourceId, occurrence.externalId, [occurrence.applyUrl]) : undefined);
    if (direct) result.push(direct);
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
): PresentationDisagreement | undefined {
  const values = {} as PresentationDisagreement['values'];
  const fields: PresentationField[] = [];
  for (const field of Object.keys(presentation(members[0]!)) as PresentationField[]) {
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

export function postingIdentityRepairPlan(catalogRows: CatalogRow[], userRows: UserRow[], proposalRows: ProposalRow[] = []): InternalPlan {
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
      job = { ...job, sourceReferences: [...new Map([
        ...job.sourceReferences, ...(occurrencesByJob.get(job.jobId) ?? []),
      ].map((item) => [occurrenceKey(item), item])).values()] };
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
    const disagreement = ordered.length > 1
      ? presentationDisagreement(key, canonical.job.jobId, ordered.map((item) => item.job))
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
    // Provider identity does not authorize a presentation choice. Leave every
    // member and dependent record untouched until #120 supplies one reviewed
    // employer/metadata/destination/admission result for this group.
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
      : mergeJob(canonical.job, ordered.map((item) => item.job), identity);
    canonicalJobs.set(canonical.job.jobId, merged);
    for (const item of ordered) canonicalByJobId.set(item.job.jobId, canonical.job.jobId);
    if (JSON.stringify(merged) !== canonical.row.value) catalogWrites.push({ before: canonical.row, pk: canonical.row.pk, sk: canonical.row.sk, kind: 'internship', value: JSON.stringify(merged), columns: jobColumns(merged) });
    catalogDeletes.push(...ordered.slice(1).map((item) => item.row));
    const aliasValues = new Set(identity.aliases.filter((item) => item.value.startsWith('provider:')).map((item) => item.value));
    aliasValues.add(`provider:${key}`);
    for (const alias of [...aliasValues].sort()) {
      const pk = `POSTING_ALIAS#${alias}`; const existing = catalogByKey.get(`${pk}\0CLAIM`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
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

  let occurrenceRemaps = 0;
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const value = parse<{ jobId: string; occurrence: SourceOccurrence }>(row.value);
      const canonical = canonicalByJobId.get(value.jobId);
      if (!canonical || canonical === value.jobId) continue;
      occurrenceRemaps += 1;
      const evidence = value.occurrence.providerEvidence ?? (value.occurrence.externalId
        ? providerEvidenceForOccurrence(value.occurrence.sourceId, value.occurrence.externalId, [value.occurrence.applyUrl]) : undefined);
      catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind, value: JSON.stringify({
        ...value, jobId: canonical, occurrence: evidence ? { ...value.occurrence, providerEvidence: evidence } : value.occurrence,
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
    repairToken, providerGroups: groups.size, duplicateGroups, duplicateJobs,
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
function operationId(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

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
  for (let offset = 0; offset < values.length; offset += 50) await db.batch(values.slice(offset, offset + 50).map((item) => db.prepare(
    `INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id) VALUES (?, ?, '${STAGE_KIND}', ?, ?, ?)`,
  ).bind(pk, operationId(item), JSON.stringify(item), item.key1, item.key2)));
  return pk;
}

function guardClause() { return "EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = 'GUARD' AND kind = 'posting-identity-repair-guard')"; }

function repairReport(plan: InternalPlan): PostingIdentityRepairPlan {
  return {
    repairToken: plan.repairToken, providerGroups: plan.providerGroups, duplicateGroups: plan.duplicateGroups,
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

export async function runPostingIdentityRepair(db: D1Database, options: { apply?: boolean; repairToken?: string; expectedChanges?: number; expectedDuplicateJobs?: number } = {}): Promise<PostingIdentityRepairPlan> {
  const [catalog, users, proposals] = await Promise.all([
    db.prepare('SELECT * FROM catalog_items ORDER BY pk, sk').all<CatalogRow>(),
    db.prepare('SELECT * FROM user_items ORDER BY user_id, item_key').all<UserRow>(),
    db.prepare('SELECT id, job_id FROM employer_field_proposals ORDER BY id').all<ProposalRow>(),
  ]);
  const plan = postingIdentityRepairPlan(catalog.results, users.results, proposals.results);
  const report = repairReport(plan);
  if (!options.apply) return report;
  if (plan.conflicts.length) throw new Error('Refusing apply while posting identity conflicts remain');
  if (plan.presentationDisagreements.length) {
    throw new Error('Refusing apply while duplicate groups have unresolved presentation disagreements');
  }
  if (options.repairToken !== plan.repairToken || options.expectedChanges !== plan.expectedChanges || options.expectedDuplicateJobs !== plan.duplicateJobs) {
    throw new Error('Catalog changed after dry run; use its exact repair token, changed-record count, and duplicate-job count');
  }
  if (!plan.expectedChanges) return { ...report, applied: true };
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
