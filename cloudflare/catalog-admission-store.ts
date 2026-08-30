import { createHash } from 'node:crypto';
import { alertEligible, catalogEligible, deriveCanonicalAdmission, evaluateCatalogAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { openCatalogSortKey } from '../src/catalog-recency.js';
import { catalogSearchText, catalogSourceClasses } from '../src/catalog-fields.js';
import { canonicalCompanyKey } from '../src/core/normalize.js';
import { providerPostingReference } from '../src/identity/posting.js';
import type {
  AdmissionIncident,
  CanonicalEmployer,
  CatalogAdmission,
  DestinationReviewRule,
  EmployerMapping,
  Internship,
  ProcessedListing,
  ProviderIdentity,
  SourceOccurrence,
  SourceOccurrenceState,
} from '../src/types.js';
import type { D1Database, D1PreparedStatement } from './types.js';

export const ATOMIC_REPAIR_RECORD_LIMIT = 900;

type JsonRow = { value: string };
export type RepairChange = {
  jobId: string;
  admission: CatalogAdmission;
  company?: string;
  title?: string;
  location?: string;
  locations?: string[];
  applyUrl?: string;
  normalizedUrl?: string;
  sourceReferences?: SourceOccurrence[];
  /** `null` explicitly clears stale validation; omission preserves the durable value. */
  applicationUrlValidatedAt?: string | null;
};

export interface ScheduledDestinationVerification {
  occurrenceKey: string;
  jobId: string;
  sourceId: string;
  externalId: string;
  candidateUrl: string;
  providerIdentity: ProviderIdentity;
  nextCheckAt: string;
  leaseToken: string;
}

export interface AdmissionBackfillGeneration {
  id: string;
  state: 'previewed' | 'queued' | 'complete';
  total: number;
  queued: number;
  completed: number;
  createdAt: string;
  frozenAt: string;
  updatedAt: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function repairToken(
  rows: Array<{ jobId: string; original: string; proposed: string }>,
  occurrences: Array<{ sourceId: string; externalId: string; original: string; proposed: string }> = [],
): string {
  const values = [
    ...rows.map((row) => `job\0${row.jobId}\0${hash(row.original)}\0${hash(row.proposed)}`),
    ...occurrences.map((row) => `occurrence\0${row.sourceId}\0${row.externalId}\0${hash(row.original)}\0${hash(row.proposed)}`),
  ];
  return createHash('sha256').update(values.sort().join('\n')).digest('hex');
}

function sourceReferenceKey(reference: SourceOccurrence): string {
  return `${reference.sourceId}\0${reference.externalId ?? ''}`;
}

export function destinationOccurrenceKey(sourceId: string, externalId: string): string {
  return hash(`${sourceId}\0${externalId}`);
}

export function providerIdentityForReference(reference: SourceOccurrence, prior?: CatalogAdmission['destination']): ProviderIdentity {
  let route: ReturnType<typeof providerPostingReference> = { provider: 'unknown' };
  try { route = providerPostingReference(reference.applyUrl); } catch { /* Malformed destinations remain fail-closed candidates. */ }
  const source = /^(greenhouse|lever|ashby)-(.+)$/u.exec(reference.sourceId);
  let queryPostingId: string | undefined;
  try {
    const queryId = new URL(reference.applyUrl).searchParams.get('gh_jid');
    if (queryId && /^\d+$/u.test(queryId)) queryPostingId = queryId;
  } catch { /* Preserve malformed candidate evidence. */ }
  const provider = reference.providerEvidence?.provider
    ?? (route.provider !== 'unknown' ? route.provider : undefined)
    ?? (queryPostingId ? 'greenhouse' : undefined)
    ?? prior?.provider
    ?? source?.[1] as ProviderIdentity['provider'] | undefined
    ?? 'unknown';
  const tenant = reference.providerEvidence?.tenant ?? route.tenant ?? prior?.tenant ?? source?.[2];
  const postingId = reference.providerEvidence?.postingId ?? route.postingId ?? queryPostingId
    ?? (prior?.candidateUrl === reference.applyUrl ? prior.expectedPostingId : undefined)
    ?? reference.externalId;
  const mayUseEmployerScope = reference.provenance !== 'reviewed-community'
    || reference.employerLabelOrigin === 'explicit'
    || reference.employerInheritance === 'same-tenant';
  return {
    provider, sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
    ...(mayUseEmployerScope ? { employerScope: `employer:${canonicalCompanyKey(reference.company)}` } : {}),
    ...(tenant ? { tenant } : {}),
    ...(postingId ? { postingId } : {}),
  };
}

/** A live queue item may only mutate the occurrence generation that produced it. */
export function destinationVerificationMatchesReference(
  reference: SourceOccurrence,
  request: Pick<ScheduledDestinationVerification, 'candidateUrl' | 'providerIdentity'>,
): boolean {
  if (reference.applyUrl !== request.candidateUrl) return false;
  const current = providerIdentityForReference(reference, reference.admission?.destination);
  const equal = (left: string | undefined, right: string | undefined) => left?.toLowerCase() === right?.toLowerCase();
  return current.sourceId === request.providerIdentity.sourceId
    && current.sourceUrl === request.providerIdentity.sourceUrl
    && (current.provider === 'unknown' || current.provider === request.providerIdentity.provider)
    && (!current.tenant || equal(current.tenant, request.providerIdentity.tenant))
    && (!current.postingId || equal(current.postingId, request.providerIdentity.postingId));
}

function sameProviderIdentity(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return left.provider === right.provider && left.sourceId === right.sourceId && left.sourceUrl === right.sourceUrl
    && left.tenant === right.tenant && left.postingId === right.postingId && left.employerScope === right.employerScope;
}

function occurrenceSnapshotHash(reference: SourceOccurrence): string {
  // Admission is the only repair-owned occurrence field. Excluding it keeps a
  // successful apply rerunnable at zero while every upstream/source field is frozen.
  const sourceOwned = { ...reference };
  delete sourceOwned.admission;
  return hash(JSON.stringify(sourceOwned));
}

function repairedSourceReferences(current: Internship, proposed: SourceOccurrence[] | undefined): SourceOccurrence[] {
  if (!proposed) return current.sourceReferences;
  const currentByKey = new Map(current.sourceReferences.map((reference) => [sourceReferenceKey(reference), reference]));
  if (currentByKey.size !== current.sourceReferences.length || proposed.length !== current.sourceReferences.length) {
    throw new Error('Admission repair cannot add, remove, or duplicate source occurrences');
  }
  for (const reference of proposed) {
    const original = currentByKey.get(sourceReferenceKey(reference));
    if (!original) throw new Error('Admission repair cannot change source occurrence identity');
    for (const field of ['sourceId', 'externalId', 'document', 'sourceUrl', 'row', 'provenance', 'state'] as const) {
      if (reference[field] !== original[field]) throw new Error(`Admission repair cannot change source occurrence ${field}`);
    }
  }
  return proposed;
}

function preserveDurableFields(current: Internship, change: RepairChange): Internship {
  const sourceReferences = repairedSourceReferences(current, change.sourceReferences);
  const repaired: Internship = {
    ...current,
    ...(change.company ? { company: change.company } : {}),
    ...(change.title ? { title: change.title } : {}),
    ...(change.location ? { location: change.location } : {}),
    ...(change.locations ? { locations: change.locations } : {}),
    ...(change.applyUrl ? { applyUrl: change.applyUrl } : {}),
    ...(change.normalizedUrl ? { normalizedUrl: change.normalizedUrl } : {}),
    admission: change.admission,
    // These fields are intentionally restated so a future expansion of the
    // editable set cannot silently reset identity or delivery history.
    jobId: current.jobId,
    firstSeenAt: current.firstSeenAt,
    catalogVisibleAt: current.catalogVisibleAt,
    catalogRecency: current.catalogRecency,
    sourceReferences,
    postingIdentity: current.postingIdentity,
    notification: current.notification,
  };
  if (change.applicationUrlValidatedAt === null) delete repaired.applicationUrlValidatedAt;
  else if (change.applicationUrlValidatedAt) repaired.applicationUrlValidatedAt = change.applicationUrlValidatedAt;
  return repaired;
}

export class D1CatalogAdmissionStore {
  constructor(private readonly db: D1Database) {}

  async audit(): Promise<{
    scanned: number;
    eligible: number;
    review: number;
    legacyUnclassified: number;
    byReason: Record<string, number>;
    bySource: Record<string, number>;
    byDestination: Record<string, number>;
    withNotificationHistory: number;
    freshness: { fresh: number; due: number; stale: number; staleEligible: number; missing: number };
    validationCoverage: { validated: number; missing: number };
    continuationConflicts: number;
    closureSignals: Record<string, number>;
    operations: { scheduled: number; leased: number; backfillQueued: number; backfillCompleted: number;
      repairStaged: number; repairApplied: number };
    unresolvedEmployers: Array<{ provider: string; tenant?: string; labels: string[]; evidenceUrls: string[];
      occurrenceCount: number; continuationConflicts: number; withNotificationHistory: number }>;
    records: Array<{ jobId: string; company: string; title: string; open: boolean; catalogEligible: boolean;
      reasonCodes: string[]; sourceIds: string[]; destinationClassification?: string; smsSent: boolean }>;
  }> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship'").all<JsonRow>();
    const jobs = rows.results.map((row) => JSON.parse(row.value) as Internship);
    const byReason: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byDestination: Record<string, number> = {};
    const closureSignals: Record<string, number> = {};
    const unresolved = new Map<string, { provider: string; tenant?: string; labels: Set<string>; evidenceUrls: Set<string>;
      occurrenceCount: number; continuationConflicts: number; notifiedJobs: Set<string> }>();
    for (const job of jobs) for (const reason of job.admission?.reasonCodes ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1;
    for (const job of jobs) {
      for (const sourceId of new Set(job.sourceReferences.map((reference) => reference.sourceId))) {
        bySource[sourceId] = (bySource[sourceId] ?? 0) + 1;
      }
      const classification = job.admission?.destination.classification ?? 'legacy-unclassified';
      byDestination[classification] = (byDestination[classification] ?? 0) + 1;
      const closureSignal = job.admission?.destination.closureSignal;
      if (closureSignal) closureSignals[closureSignal] = (closureSignals[closureSignal] ?? 0) + 1;
      for (const reference of job.sourceReferences) {
        if (reference.admission?.employerResolution === 'resolved' && reference.employerInheritance !== 'conflict') continue;
        const destination = reference.admission?.destination;
        let route: ReturnType<typeof providerPostingReference> = { provider: 'unknown' };
        try { route = providerPostingReference(reference.applyUrl); } catch { /* Preserve malformed candidate evidence. */ }
        const provider = destination?.provider ?? route.provider;
        const tenant = destination?.tenant ?? route.tenant;
        const key = `${provider}\0${tenant ?? ''}`;
        const group = unresolved.get(key) ?? { provider, ...(tenant ? { tenant } : {}), labels: new Set<string>(),
          evidenceUrls: new Set<string>(), occurrenceCount: 0, continuationConflicts: 0, notifiedJobs: new Set<string>() };
        group.labels.add(reference.company); group.evidenceUrls.add(reference.applyUrl); group.occurrenceCount += 1;
        if (reference.employerInheritance === 'conflict') group.continuationConflicts += 1;
        if (job.notification.smsSentAt || job.notification.digestedAt) group.notifiedJobs.add(job.jobId);
        unresolved.set(key, group);
      }
    }
    const now = Date.now();
    const freshness = { fresh: 0, due: 0, stale: 0, staleEligible: 0, missing: 0 };
    for (const job of jobs) {
      const destination = job.admission?.destination;
      if (!destination) { freshness.missing += 1; continue; }
      const freshUntil = destination.freshUntil
        ?? new Date(Date.parse(destination.inspectedAt) + 7 * 86_400_000).toISOString();
      if (Date.parse(freshUntil) <= now) {
        freshness.stale += 1;
        if (job.open && job.admission?.catalogEligible) freshness.staleEligible += 1;
      }
      else if (Date.parse(destination.nextCheckAt ?? freshUntil) <= now) freshness.due += 1;
      else freshness.fresh += 1;
    }
    const [scheduled, leased, backfillQueued, backfillCompleted, repairStaged, repairApplied] = await Promise.all([
      this.db.prepare('SELECT count(*) AS count FROM destination_verification_schedule').first<{ count: number }>(),
      this.db.prepare("SELECT count(*) AS count FROM destination_verification_schedule WHERE lease_until IS NOT NULL").first<{ count: number }>(),
      this.db.prepare("SELECT count(*) AS count FROM admission_backfill_items WHERE state = 'queued'").first<{ count: number }>(),
      this.db.prepare("SELECT count(*) AS count FROM admission_backfill_items WHERE state = 'completed'").first<{ count: number }>(),
      this.db.prepare('SELECT count(*) AS count FROM catalog_admission_repair_stage').first<{ count: number }>(),
      this.db.prepare('SELECT count(*) AS count FROM catalog_admission_repair_guards').first<{ count: number }>(),
    ]);
    return {
      scanned: jobs.length,
      eligible: jobs.filter((job) => catalogEligible(job)).length,
      review: jobs.filter((job) => job.admission?.catalogEligible === false).length,
      legacyUnclassified: jobs.filter((job) => !job.admission).length,
      byReason,
      bySource,
      byDestination,
      withNotificationHistory: jobs.filter((job) => Boolean(job.notification.smsSentAt)).length,
      freshness,
      validationCoverage: { validated: jobs.filter((job) => Boolean(job.applicationUrlValidatedAt)).length,
        missing: jobs.filter((job) => !job.applicationUrlValidatedAt).length },
      continuationConflicts: jobs.flatMap((job) => job.sourceReferences).filter((reference) => reference.employerInheritance === 'conflict').length,
      closureSignals,
      operations: { scheduled: scheduled?.count ?? 0, leased: leased?.count ?? 0, backfillQueued: backfillQueued?.count ?? 0,
        backfillCompleted: backfillCompleted?.count ?? 0, repairStaged: repairStaged?.count ?? 0, repairApplied: repairApplied?.count ?? 0 },
      unresolvedEmployers: [...unresolved.values()].map((group) => ({ provider: group.provider, ...(group.tenant ? { tenant: group.tenant } : {}),
        labels: [...group.labels].sort(), evidenceUrls: [...group.evidenceUrls].sort(), occurrenceCount: group.occurrenceCount,
        continuationConflicts: group.continuationConflicts, withNotificationHistory: group.notifiedJobs.size }))
        .sort((left, right) => left.provider.localeCompare(right.provider) || (left.tenant ?? '').localeCompare(right.tenant ?? '')),
      records: jobs.filter((job) => job.admission?.catalogEligible === false).map((job) => ({
        jobId: job.jobId, company: job.company, title: job.title, open: job.open,
        catalogEligible: false, reasonCodes: job.admission?.reasonCodes ?? [],
        sourceIds: [...new Set(job.sourceReferences.map((reference) => reference.sourceId))].sort(),
        ...(job.admission ? { destinationClassification: job.admission.destination.classification } : {}),
        smsSent: Boolean(job.notification.smsSentAt),
      })),
    };
  }

  async listCanonicalEmployers(): Promise<CanonicalEmployer[]> {
    const rows = await this.db.prepare('SELECT * FROM canonical_employers ORDER BY display_name').all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, displayName: row.display_name as string, reviewedAt: row.reviewed_at as string,
      reviewedBy: row.reviewed_by as string,
      ...(row.parent_employer_id ? { parentEmployerId: row.parent_employer_id as string } : {}),
      ...(row.brand_of_employer_id ? { brandOfEmployerId: row.brand_of_employer_id as string } : {}),
    }));
  }

  async putCanonicalEmployer(value: CanonicalEmployer, now: string): Promise<void> {
    await this.db.prepare(`INSERT INTO canonical_employers
      (id, display_name, reviewed_at, reviewed_by, parent_employer_id, brand_of_employer_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, reviewed_at=excluded.reviewed_at,
        reviewed_by=excluded.reviewed_by, parent_employer_id=excluded.parent_employer_id,
        brand_of_employer_id=excluded.brand_of_employer_id, updated_at=excluded.updated_at`)
      .bind(value.id, value.displayName, value.reviewedAt, value.reviewedBy, value.parentEmployerId ?? null, value.brandOfEmployerId ?? null, now, now).run();
  }

  async listEmployerMappings(): Promise<EmployerMapping[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_mappings ORDER BY provider, scope, reviewed_at').all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, provider: row.provider as EmployerMapping['provider'], scope: row.scope as string,
      canonicalEmployerId: row.canonical_employer_id as string, reviewedAt: row.reviewed_at as string,
      reviewedBy: row.reviewed_by as string,
      ...(row.supersedes_mapping_id ? { supersedesMappingId: row.supersedes_mapping_id as string } : {}),
      ...(row.superseded_at ? { supersededAt: row.superseded_at as string } : {}),
    }));
  }

  async resolveCanonicalEmployer(identity: ProviderIdentity): Promise<Pick<CanonicalEmployer, 'id' | 'displayName'> | undefined> {
    // A GitHub document contains many employers, so its source ID can never be
    // an employer identity. Official single-employer feeds retain their broad
    // source/tenant mappings and can fall back to the row's employer scope.
    const rawScopes = (identity.provider === 'github'
      ? [identity.employerScope]
      : [identity.sourceId, identity.tenant, identity.employerScope])
      .filter((value): value is string => Boolean(value));
    // Community ingestion historically encoded the same conservative company
    // key with either spaces or hyphens. Try only that representation variant;
    // the reviewed mapping still defines every accepted employer identity.
    const scopes = [...new Set(rawScopes.flatMap((scope) => scope.startsWith('employer:')
      ? [scope, `employer:${scope.slice('employer:'.length).replace(/[\s_]+/gu, '-')}`]
      : [scope]))];
    for (const scope of scopes) {
      const row = await this.db.prepare(`SELECT employer.id, employer.display_name
        FROM employer_mappings AS mapping
        JOIN canonical_employers AS employer ON employer.id = mapping.canonical_employer_id
        WHERE mapping.provider = ? AND mapping.scope = ? AND mapping.superseded_at IS NULL`)
        .bind(identity.provider, scope).first<{ id: string; display_name: string }>();
      if (row) return { id: row.id, displayName: row.display_name };
    }
    return undefined;
  }

  async configurationVersion(): Promise<string> {
    const [employers, mappings, rules] = await Promise.all([
      this.listCanonicalEmployers(), this.listEmployerMappings(), this.listReviewRules(),
    ]);
    const stable = <T>(values: T[]) => values
      .map((value) => JSON.stringify(value))
      .sort()
      .map((value) => JSON.parse(value) as T);
    return hash(JSON.stringify({ employers: stable(employers), mappings: stable(mappings), rules: stable(rules) }));
  }

  async supersedeEmployerMapping(value: EmployerMapping): Promise<void> {
    const active = await this.db.prepare('SELECT id FROM employer_mappings WHERE provider = ? AND scope = ? AND superseded_at IS NULL')
      .bind(value.provider, value.scope).first<{ id: string }>();
    if (active?.id && value.supersedesMappingId !== active.id) throw new Error('The active employer mapping must be explicitly superseded');
    if (!active && value.supersedesMappingId) throw new Error('No active employer mapping exists to supersede');
    const statements = [];
    if (active) statements.push(this.db.prepare('UPDATE employer_mappings SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL').bind(value.reviewedAt, active.id));
    statements.push(this.db.prepare(`INSERT INTO employer_mappings
      (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, supersedes_mapping_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.provider, value.scope, value.canonicalEmployerId, value.reviewedAt, value.reviewedBy, value.supersedesMappingId ?? null, value.reviewedAt));
    await this.db.batch(statements);
  }

  async listReviewRules(): Promise<DestinationReviewRule[]> {
    const rows = await this.db.prepare('SELECT * FROM destination_review_rules ORDER BY host, provider, tenant').all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, host: row.host as string, provider: row.provider as DestinationReviewRule['provider'],
      ...(row.tenant ? { tenant: row.tenant as string } : {}), decision: row.decision as DestinationReviewRule['decision'],
      reviewedAt: row.reviewed_at as string, reviewedBy: row.reviewed_by as string,
      ...(row.sample_due_at ? { sampleDueAt: row.sample_due_at as string } : {}),
    }));
  }

  async resolveReviewRule(identity: ProviderIdentity, candidateUrl: string): Promise<DestinationReviewRule | undefined> {
    let host: string;
    try { host = new URL(candidateUrl).hostname.toLowerCase(); } catch { return undefined; }
    const row = await this.db.prepare(`SELECT * FROM destination_review_rules
      WHERE host = ? AND provider = ? AND (tenant = ? OR tenant IS NULL)
      ORDER BY CASE WHEN tenant = ? THEN 0 ELSE 1 END LIMIT 1`)
      .bind(host, identity.provider, identity.tenant ?? null, identity.tenant ?? null).first<Record<string, unknown>>();
    return row ? {
      id: row.id as string, host: row.host as string, provider: row.provider as DestinationReviewRule['provider'],
      ...(row.tenant ? { tenant: row.tenant as string } : {}), decision: row.decision as DestinationReviewRule['decision'],
      reviewedAt: row.reviewed_at as string, reviewedBy: row.reviewed_by as string,
      ...(row.sample_due_at ? { sampleDueAt: row.sample_due_at as string } : {}),
    } : undefined;
  }

  async putReviewRule(value: DestinationReviewRule): Promise<void> {
    const removePrior = this.db.prepare(`DELETE FROM destination_review_rules
      WHERE host = ? AND provider = ? AND ((tenant IS NULL AND ? IS NULL) OR tenant = ?)`)
      .bind(value.host, value.provider, value.tenant ?? null, value.tenant ?? null);
    const insert = this.db.prepare(`INSERT INTO destination_review_rules
      (id, host, provider, tenant, decision, reviewed_at, reviewed_by, sample_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host=excluded.host, provider=excluded.provider, tenant=excluded.tenant,
        decision=excluded.decision, reviewed_at=excluded.reviewed_at, reviewed_by=excluded.reviewed_by,
        sample_due_at=excluded.sample_due_at`)
      .bind(value.id, value.host, value.provider, value.tenant ?? null, value.decision, value.reviewedAt, value.reviewedBy, value.sampleDueAt ?? null);
    await this.db.batch([removePrior, insert]);
  }

  async recordReviewerDecision(value: {
    id: string;
    subjectType: 'canonical-employer' | 'employer-mapping' | 'destination-rule' | 'catalog-repair';
    subjectId: string;
    decision: string;
    reason: string;
    reviewedAt: string;
    reviewedBy: string;
  }): Promise<void> {
    await this.db.prepare(`INSERT INTO admission_reviewer_decisions
      (id, subject_type, subject_id, decision, reason, reviewed_at, reviewed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.subjectType, value.subjectId, value.decision, value.reason, value.reviewedAt, value.reviewedBy).run();
  }

  async reviewSampleCandidates(rule: DestinationReviewRule, limit = 3): Promise<Array<{
    jobId: string; sourceId: string; externalId: string; sourceUrl: string; candidateUrl: string; expectedPostingId?: string;
  }>> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship'").all<JsonRow>();
    const candidates: Array<{ jobId: string; sourceId: string; externalId: string; sourceUrl: string; candidateUrl: string; expectedPostingId?: string }> = [];
    for (const row of rows.results) {
      const job = JSON.parse(row.value) as Internship;
      for (const reference of job.sourceReferences) {
        if (!reference.externalId || !reference.admission) continue;
        const destination = reference.admission.destination;
        let host: string;
        try { host = new URL(destination.candidateUrl).hostname.toLowerCase(); } catch { continue; }
        if (host !== rule.host || destination.provider !== rule.provider || (rule.tenant && destination.tenant !== rule.tenant)) continue;
        candidates.push({ jobId: job.jobId, sourceId: reference.sourceId, externalId: reference.externalId,
          sourceUrl: reference.sourceUrl, candidateUrl: destination.candidateUrl,
          ...(destination.expectedPostingId ? { expectedPostingId: destination.expectedPostingId } : {}) });
        if (candidates.length === limit) return candidates;
      }
    }
    return candidates;
  }

  async legacyVerificationCandidates(limit = 100): Promise<Array<{
    jobId: string; sourceId: string; externalId: string; candidateUrl: string; providerIdentity: ProviderIdentity;
    occurrenceSnapshotHash: string;
  }>> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship' ORDER BY pk").all<JsonRow>();
    const candidates: Array<{ jobId: string; sourceId: string; externalId: string; candidateUrl: string;
      providerIdentity: ProviderIdentity; occurrenceSnapshotHash: string }> = [];
    for (const row of rows.results) {
      const job = JSON.parse(row.value) as Internship;
      for (const reference of job.sourceReferences) {
        if (!reference.externalId || reference.admission) continue;
        const providerIdentity = providerIdentityForReference(reference);
        candidates.push({ jobId: job.jobId, sourceId: reference.sourceId, externalId: reference.externalId,
          candidateUrl: reference.applyUrl, providerIdentity, occurrenceSnapshotHash: occurrenceSnapshotHash(reference) });
        if (candidates.length >= limit) return candidates;
      }
    }
    return candidates;
  }

  async syncVerificationSchedule(now: string): Promise<number> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship' ORDER BY pk").all<JsonRow>();
    const statements: D1PreparedStatement[] = [];
    const activeKeys = new Set<string>();
    for (const row of rows.results) {
      const job = JSON.parse(row.value) as Internship;
      for (const reference of job.sourceReferences) {
        // Legacy rows are frozen through admission_backfill_generations. They
        // must never enter the mutating recurring schedule before guarded repair.
        if (!reference.externalId || reference.state !== 'open' || !reference.admission) continue;
        const prior = reference.admission.destination;
        const providerIdentity = providerIdentityForReference(reference, prior);
        const nextCheckAt = prior?.nextCheckAt ?? (prior?.freshUntil
          ? new Date(Math.max(Date.parse(prior.inspectedAt), Date.parse(prior.freshUntil) - 86_400_000)).toISOString()
          : new Date(Date.parse(prior?.inspectedAt ?? reference.admission.evaluatedAt) + 6 * 86_400_000).toISOString());
        const occurrenceKey = destinationOccurrenceKey(reference.sourceId, reference.externalId);
        activeKeys.add(occurrenceKey);
        statements.push(this.db.prepare(`INSERT INTO destination_verification_schedule
          (occurrence_key, job_id, source_id, external_id, candidate_url, provider_identity, next_check_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(occurrence_key) DO UPDATE SET job_id=excluded.job_id, candidate_url=excluded.candidate_url,
            provider_identity=excluded.provider_identity,
            next_check_at=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN excluded.updated_at ELSE destination_verification_schedule.next_check_at END,
            lease_token=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN NULL ELSE destination_verification_schedule.lease_token END,
            lease_until=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN NULL ELSE destination_verification_schedule.lease_until END,
            last_enqueued_at=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN NULL ELSE destination_verification_schedule.last_enqueued_at END,
            updated_at=excluded.updated_at`)
          .bind(occurrenceKey, job.jobId, reference.sourceId, reference.externalId, reference.applyUrl,
            JSON.stringify(providerIdentity), nextCheckAt, now));
      }
    }
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const scheduled = await this.db.prepare('SELECT occurrence_key FROM destination_verification_schedule').all<{ occurrence_key: string }>();
    const removals = scheduled.results.filter((row) => !activeKeys.has(row.occurrence_key))
      .map((row) => this.db.prepare('DELETE FROM destination_verification_schedule WHERE occurrence_key = ?').bind(row.occurrence_key));
    for (let offset = 0; offset < removals.length; offset += 50) await this.db.batch(removals.slice(offset, offset + 50));
    return statements.length;
  }

  async leaseDueVerifications(now: string, limit = 1_000, leaseMs = 15 * 60_000): Promise<ScheduledDestinationVerification[]> {
    const rows = await this.db.prepare(`SELECT * FROM destination_verification_schedule
      WHERE next_check_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_check_at, occurrence_key LIMIT ?`).bind(now, now, limit).all<Record<string, unknown>>();
    const leased: ScheduledDestinationVerification[] = [];
    for (const row of rows.results) {
      const leaseToken = crypto.randomUUID();
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const result = await this.db.prepare(`UPDATE destination_verification_schedule SET lease_token = ?, lease_until = ?, updated_at = ?
        WHERE occurrence_key = ? AND (lease_until IS NULL OR lease_until <= ?)`).bind(leaseToken, leaseUntil, now, row.occurrence_key, now).run();
      if (!result.meta.changes) continue;
      leased.push({
        occurrenceKey: row.occurrence_key as string, jobId: row.job_id as string, sourceId: row.source_id as string,
        externalId: row.external_id as string, candidateUrl: row.candidate_url as string,
        providerIdentity: JSON.parse(row.provider_identity as string) as ProviderIdentity,
        nextCheckAt: row.next_check_at as string, leaseToken,
      });
    }
    return leased;
  }

  async markVerificationEnqueued(occurrenceKey: string, leaseToken: string, enqueuedAt: string): Promise<void> {
    await this.db.prepare(`UPDATE destination_verification_schedule SET last_enqueued_at = ?, updated_at = ?
      WHERE occurrence_key = ? AND lease_token = ?`).bind(enqueuedAt, enqueuedAt, occurrenceKey, leaseToken).run();
  }

  async completeScheduledVerification(input: { occurrenceKey: string; leaseToken?: string; completedAt: string;
    classification: string; nextCheckAt: string }): Promise<void> {
    await this.db.prepare(`UPDATE destination_verification_schedule SET next_check_at = ?, lease_token = NULL, lease_until = NULL,
      last_completed_at = ?, last_classification = ?, updated_at = ?
      WHERE occurrence_key = ?${input.leaseToken ? ' AND lease_token = ?' : ''}`)
      .bind(input.nextCheckAt, input.completedAt, input.classification, input.completedAt, input.occurrenceKey,
        ...(input.leaseToken ? [input.leaseToken] : [])).run();
  }

  async verificationCompleted(idempotencyKey: string): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT idempotency_key FROM destination_verification_completions WHERE idempotency_key = ?')
      .bind(idempotencyKey).first());
  }

  async recordVerificationCompletion(idempotencyKey: string, completedAt: string): Promise<void> {
    await this.db.prepare(`INSERT INTO destination_verification_completions (idempotency_key, completed_at)
      VALUES (?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).bind(idempotencyKey, completedAt).run();
  }

  async previewBackfill(frozenAt: string): Promise<AdmissionBackfillGeneration> {
    const candidates = await this.legacyVerificationCandidates(Number.MAX_SAFE_INTEGER);
    const stable = candidates.map((candidate) => ({ ...candidate,
      occurrenceKey: destinationOccurrenceKey(candidate.sourceId, candidate.externalId) }))
      .sort((left, right) => left.occurrenceKey.localeCompare(right.occurrenceKey));
    const id = hash(JSON.stringify({ frozenAt, candidates: stable }));
    const statements = [this.db.prepare(`INSERT INTO admission_backfill_generations
      (id, state, total, queued, completed, created_at, frozen_at, updated_at) VALUES (?, 'previewed', ?, 0, 0, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(id, stable.length, frozenAt, frozenAt, frozenAt)];
    stable.forEach((candidate, ordinal) => statements.push(this.db.prepare(`INSERT INTO admission_backfill_items
      (generation_id, ordinal, occurrence_key, job_id, source_id, external_id, candidate_url, provider_identity,
       occurrence_snapshot_hash, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(generation_id, occurrence_key) DO NOTHING`)
      .bind(id, ordinal, candidate.occurrenceKey, candidate.jobId, candidate.sourceId, candidate.externalId,
        candidate.candidateUrl, JSON.stringify(candidate.providerIdentity), candidate.occurrenceSnapshotHash, frozenAt)));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    return (await this.backfillProgress(id))!;
  }

  async backfillPage(generationId: string, cursor = 0, limit = 100, includeQueued = false): Promise<Array<{
    ordinal: number; occurrenceKey: string; jobId: string; sourceId: string; externalId: string;
    candidateUrl: string; providerIdentity: ProviderIdentity;
  }>> {
    const rows = await this.db.prepare(`SELECT * FROM admission_backfill_items
      WHERE generation_id = ? AND ordinal >= ? AND state ${includeQueued ? "IN ('pending','queued')" : "= 'pending'"}
      ORDER BY ordinal LIMIT ?`)
      .bind(generationId, cursor, limit).all<Record<string, unknown>>();
    return rows.results.map((row) => ({ ordinal: row.ordinal as number, occurrenceKey: row.occurrence_key as string,
      jobId: row.job_id as string, sourceId: row.source_id as string, externalId: row.external_id as string,
      candidateUrl: row.candidate_url as string, providerIdentity: JSON.parse(row.provider_identity as string) as ProviderIdentity }));
  }

  async markBackfillQueued(generationId: string, occurrenceKeys: string[], updatedAt: string): Promise<void> {
    if (!occurrenceKeys.length) return;
    const statements = occurrenceKeys.map((key) => this.db.prepare(`UPDATE admission_backfill_items SET state = 'queued', updated_at = ?
      WHERE generation_id = ? AND occurrence_key = ? AND state = 'pending'`).bind(updatedAt, generationId, key));
    await this.db.batch(statements);
    await this.refreshBackfillProgress(generationId, updatedAt);
  }

  async recordBackfillEvidence(input: { generationId: string; occurrenceKey: string; evidenceHash: string;
    classification: string; value: unknown; observedAt: string }): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT INTO admission_backfill_evidence
        (generation_id, occurrence_key, evidence_hash, classification, value, observed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_id, occurrence_key) DO NOTHING`)
        .bind(input.generationId, input.occurrenceKey, input.evidenceHash, input.classification, JSON.stringify(input.value), input.observedAt),
      this.db.prepare(`UPDATE admission_backfill_items SET state = 'completed',
        evidence_hash = (SELECT evidence_hash FROM admission_backfill_evidence
          WHERE generation_id = ? AND occurrence_key = ?), updated_at = ?
        WHERE generation_id = ? AND occurrence_key = ?`)
        .bind(input.generationId, input.occurrenceKey, input.observedAt, input.generationId, input.occurrenceKey),
    ]);
    await this.refreshBackfillProgress(input.generationId, input.observedAt);
  }

  private async refreshBackfillProgress(generationId: string, updatedAt: string): Promise<void> {
    await this.db.prepare(`UPDATE admission_backfill_generations SET
      queued = (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state IN ('queued','completed')),
      completed = (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state = 'completed'),
      state = CASE WHEN (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state = 'completed') = total
        THEN 'complete' WHEN (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state IN ('queued','completed')) > 0
        THEN 'queued' ELSE 'previewed' END,
      updated_at = ? WHERE id = ?`).bind(generationId, generationId, generationId, generationId, updatedAt, generationId).run();
  }

  async backfillProgress(generationId: string): Promise<AdmissionBackfillGeneration | undefined> {
    const row = await this.db.prepare('SELECT * FROM admission_backfill_generations WHERE id = ?')
      .bind(generationId).first<Record<string, unknown>>();
    return row ? { id: row.id as string, state: row.state as AdmissionBackfillGeneration['state'], total: row.total as number,
      queued: row.queued as number, completed: row.completed as number, createdAt: row.created_at as string,
      frozenAt: row.frozen_at as string, updatedAt: row.updated_at as string } : undefined;
  }

  async deriveBackfillRepairBatch(generationId: string, sourceId: string, cursor = 0, recordLimit = 850): Promise<{
    changes: RepairChange[]; records: number; nextCursor: number | null;
  }> {
    if (recordLimit < 1 || recordLimit >= ATOMIC_REPAIR_RECORD_LIMIT) throw new Error('Backfill repair recordLimit must be between 1 and 899');
    const rows = await this.db.prepare(`SELECT item.*, evidence.value AS evidence_value, evidence.observed_at
      FROM admission_backfill_items AS item
      JOIN admission_backfill_evidence AS evidence
        ON evidence.generation_id = item.generation_id AND evidence.occurrence_key = item.occurrence_key
      WHERE item.generation_id = ? AND item.source_id = ? AND item.state = 'completed' AND item.ordinal >= ?
      ORDER BY item.ordinal`).bind(generationId, sourceId, cursor).all<Record<string, unknown>>();
    const changes = new Map<string, { job: Internship; references: SourceOccurrence[]; maxOrdinal: number; changedOccurrences: number }>();
    let records = 0;
    let nextCursor: number | null = null;
    for (const row of rows.results) {
      const ordinal = row.ordinal as number;
      const existing = changes.get(row.job_id as string);
      const jobRow = existing ? undefined : await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship'")
        .bind(`JOB#${row.job_id as string}`).first<JsonRow>();
      if (!existing && !jobRow) throw new Error(`Backfill generation ${generationId} drifted: job ${row.job_id as string} was removed`);
      const job = existing?.job ?? JSON.parse(jobRow!.value) as Internship;
      const referenceAt = job.sourceReferences.findIndex((reference) => reference.sourceId === row.source_id && reference.externalId === row.external_id);
      if (referenceAt < 0) throw new Error(`Backfill generation ${generationId} drifted at ${row.source_id as string}:${row.external_id as string}; preview again`);
      const proposedRecordCost = existing ? 1 : 2;
      if (records + proposedRecordCost > recordLimit) { nextCursor = ordinal; break; }
      const references = existing?.references ?? [...job.sourceReferences];
      const reference = references[referenceAt]!;
      const providerIdentity = JSON.parse(row.provider_identity as string) as ProviderIdentity;
      const currentIdentity = providerIdentityForReference(reference, reference.admission?.destination);
      if (occurrenceSnapshotHash(reference) !== row.occurrence_snapshot_hash
        || reference.applyUrl !== row.candidate_url || !sameProviderIdentity(providerIdentity, currentIdentity)) {
        throw new Error(`Backfill generation ${generationId} drifted at ${row.source_id as string}:${row.external_id as string}; preview again`);
      }
      const mappedEmployer = await this.resolveCanonicalEmployer(providerIdentity);
      const mayReuseEmployer = reference.employerLabelOrigin !== 'inherited' || reference.employerInheritance === 'same-tenant';
      const listing: ProcessedListing = { ...reference, fetchedAt: row.observed_at as string, providerIdentity,
        postingIdentity: job.postingIdentity,
        employerEvidence: { authority: reference.provenance === 'reviewed-community' ? 'source-row' : 'reviewed-registry',
          ...(mappedEmployer ? { canonicalEmployer: mappedEmployer }
            : mayReuseEmployer && reference.admission?.canonicalEmployer ? { canonicalEmployer: reference.admission.canonicalEmployer } : {}) },
        metadataCompleteness: reference.admission?.metadata
          ?? metadataCompleteness({ title: reference.title, locations: reference.locations ?? [reference.location] }) };
      const destination = JSON.parse(row.evidence_value as string) as CatalogAdmission['destination'];
      const admission = evaluateCatalogAdmission({ listing, destination,
        postingAttributed: reference.provenance !== 'reviewed-community'
          || (destination.browserVisible === true && ['posting-detail', 'application-form'].includes(destination.classification)),
        evaluatedAt: row.observed_at as string, previous: reference.admission ?? job.admission });
      references[referenceAt] = { ...reference, admission };
      changes.set(job.jobId, { job, references, maxOrdinal: ordinal, changedOccurrences: (existing?.changedOccurrences ?? 0) + 1 });
      records += proposedRecordCost;
    }
    const repairChanges = [...changes.values()].map(({ job, references }) => {
      const admission = deriveCanonicalAdmission(references,
        references.map((reference) => reference.admission?.evaluatedAt ?? '').sort().at(-1)!)!;
      return { jobId: job.jobId, admission, sourceReferences: references,
        applicationUrlValidatedAt: admission.catalogEligible
          && ['posting-detail', 'application-form'].includes(admission.destination.classification)
          ? admission.destination.inspectedAt : null };
    });
    if (nextCursor === null && rows.results.length) nextCursor = null;
    return { changes: repairChanges, records, nextCursor };
  }

  async markReviewRuleSampled(id: string, sampleDueAt: string): Promise<void> {
    await this.db.prepare('UPDATE destination_review_rules SET sample_due_at = ? WHERE id = ?').bind(sampleDueAt, id).run();
  }

  async listActiveIncidents(): Promise<AdmissionIncident[]> {
    const rows = await this.db.prepare("SELECT * FROM admission_incidents WHERE state IN ('open','quarantined') ORDER BY grace_deadline, opened_at").all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, jobId: row.job_id as string, sourceId: row.source_id as string, host: row.host as string,
      reasonCode: row.reason_code as AdmissionIncident['reasonCode'], state: row.state as AdmissionIncident['state'],
      openedAt: row.opened_at as string, updatedAt: row.updated_at as string,
      ...(row.grace_deadline ? { graceDeadline: row.grace_deadline as string } : {}),
      ...(row.warning_sent_at ? { warningSentAt: row.warning_sent_at as string } : {}),
      ...(row.quarantine_sent_at ? { quarantineSentAt: row.quarantine_sent_at as string } : {}),
    }));
  }

  async resolveIncidents(jobId: string, sourceId: string, updatedAt: string, exceptReason?: AdmissionIncident['reasonCode']): Promise<void> {
    const condition = exceptReason ? ' AND reason_code <> ?' : '';
    await this.db.prepare(`UPDATE admission_incidents SET state = 'resolved', updated_at = ?
      WHERE job_id = ? AND source_id = ? AND state IN ('open','quarantined')${condition}`)
      .bind(updatedAt, jobId, sourceId, ...(exceptReason ? [exceptReason] : [])).run();
  }

  async recordVerificationAttempt(value: {
    id: string; jobId: string; sourceId: string; candidateUrl: string;
    state: 'succeeded' | 'failed'; classification?: string; error?: string;
    attemptedAt: string; completedAt: string;
  }, evidence?: { hash: string; classification: string; value: unknown; observedAt: string }): Promise<void> {
    const statements = [this.db.prepare(`INSERT INTO destination_verification_attempts
      (id, job_id, source_id, candidate_url, state, classification, error, attempted_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.jobId, value.sourceId, value.candidateUrl, value.state, value.classification ?? null, value.error ?? null, value.attemptedAt, value.completedAt)];
    if (evidence) statements.push(this.db.prepare(`INSERT INTO destination_verification_evidence
      (job_id, evidence_hash, classification, value, observed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id, evidence_hash) DO UPDATE SET classification=excluded.classification, value=excluded.value, observed_at=excluded.observed_at`)
      .bind(value.jobId, evidence.hash, evidence.classification, JSON.stringify(evidence.value), evidence.observedAt));
    await this.db.batch(statements);
  }

  async hasVerificationAttemptSince(jobId: string, sourceId: string, candidateUrl: string, since: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`SELECT id FROM destination_verification_attempts
      WHERE job_id = ? AND source_id = ? AND candidate_url = ? AND completed_at >= ?
      ORDER BY completed_at DESC LIMIT 1`)
      .bind(jobId, sourceId, candidateUrl, since).first<{ id: string }>());
  }

  async renderedEvidenceCollisionJobIds(jobId: string, renderedEvidenceHash: string, expectedPostingId: string): Promise<string[]> {
    const rows = await this.db.prepare(`SELECT DISTINCT job_id FROM destination_verification_evidence
      WHERE job_id <> ?
        AND json_extract(value, '$.renderedEvidenceHash') = ?
        AND coalesce(json_extract(value, '$.expectedPostingId'), '') <> ?
      ORDER BY job_id`).bind(jobId, renderedEvidenceHash, expectedPostingId).all<{ job_id: string }>();
    return rows.results.map((row) => row.job_id);
  }

  async hasRenderedEvidenceCollision(jobId: string, renderedEvidenceHash: string, expectedPostingId: string): Promise<boolean> {
    return (await this.renderedEvidenceCollisionJobIds(jobId, renderedEvidenceHash, expectedPostingId)).length > 0;
  }

  async upsertIncident(value: AdmissionIncident): Promise<void> {
    await this.db.prepare(`INSERT INTO admission_incidents
      (id, job_id, source_id, host, reason_code, state, opened_at, updated_at, grace_deadline, warning_sent_at, quarantine_sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, reason_code=excluded.reason_code,
        updated_at=excluded.updated_at, grace_deadline=excluded.grace_deadline,
        warning_sent_at=coalesce(excluded.warning_sent_at, admission_incidents.warning_sent_at),
        quarantine_sent_at=coalesce(excluded.quarantine_sent_at, admission_incidents.quarantine_sent_at)`)
      .bind(value.id, value.jobId, value.sourceId, value.host, value.reasonCode, value.state,
        value.openedAt, value.updatedAt, value.graceDeadline ?? null, value.warningSentAt ?? null, value.quarantineSentAt ?? null).run();
  }

  async emailDeliveryExists(dedupeKey: string): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT dedupe_key FROM admission_email_deliveries WHERE dedupe_key = ?').bind(dedupeKey).first());
  }

  async recordEmailDelivery(dedupeKey: string, incidentId: string, messageType: string, sentAt: string): Promise<void> {
    await this.db.prepare(`INSERT INTO admission_email_deliveries (dedupe_key, incident_id, message_type, sent_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`).bind(dedupeKey, incidentId, messageType, sentAt).run();
  }

  async markIncidentNotification(id: string, messageType: 'grace-warning' | 'quarantine', sentAt: string): Promise<void> {
    const column = messageType === 'grace-warning' ? 'warning_sent_at' : 'quarantine_sent_at';
    await this.db.prepare(`UPDATE admission_incidents SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .bind(sentAt, sentAt, id).run();
  }

  async stageRepair(changes: RepairChange[], createdAt: string): Promise<{
    repairToken: string; changed: number; candidates: string[]; occurrencesChanged: number; occurrenceCandidates: string[];
  }> {
    if (!changes.length) return { repairToken: repairToken([]), changed: 0, candidates: [], occurrencesChanged: 0, occurrenceCandidates: [] };
    if (new Set(changes.map((change) => change.jobId)).size !== changes.length) throw new Error('Repair job IDs must be unique');
    const rows: Array<{ jobId: string; original: string; proposed: string; job: Internship }> = [];
    const occurrences: Array<{ sourceId: string; externalId: string; original: string; proposed: string }> = [];
    for (const change of changes) {
      const row = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship'")
        .bind(`JOB#${change.jobId}`).first<JsonRow>();
      if (!row) throw new Error(`Repair job ${change.jobId} was not found`);
      const current = JSON.parse(row.value) as Internship;
      const proposed = preserveDurableFields(current, change);
      const proposedValue = JSON.stringify(proposed);
      if (row.value !== proposedValue) rows.push({ jobId: change.jobId, original: row.value, proposed: proposedValue, job: proposed });
      if (change.sourceReferences) {
        const originalByKey = new Map(current.sourceReferences.map((reference) => [sourceReferenceKey(reference), reference]));
        for (const reference of change.sourceReferences) {
          if (!reference.externalId || JSON.stringify(originalByKey.get(sourceReferenceKey(reference))) === JSON.stringify(reference)) continue;
          const occurrenceRow = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = ? AND kind = 'source-occurrence'")
            .bind(`SOURCE#${reference.sourceId}`, `OCCURRENCE#${reference.externalId}`).first<JsonRow>();
          if (!occurrenceRow) throw new Error(`Source occurrence ${reference.sourceId}:${reference.externalId} was not found`);
          const state = JSON.parse(occurrenceRow.value) as SourceOccurrenceState;
          if (state.jobId !== current.jobId) throw new Error(`Source occurrence ${reference.sourceId}:${reference.externalId} belongs to another job`);
          occurrences.push({ sourceId: reference.sourceId, externalId: reference.externalId,
            original: occurrenceRow.value, proposed: JSON.stringify({ ...state, occurrence: reference }) });
        }
      }
    }
    if (new Set(occurrences.map((item) => `${item.sourceId}\0${item.externalId}`)).size !== occurrences.length) {
      throw new Error('Admission repair source occurrences must be unique');
    }
    if (rows.length + occurrences.length > ATOMIC_REPAIR_RECORD_LIMIT) {
      throw new Error(`Admission repair exceeds the atomic D1 limit of ${ATOMIC_REPAIR_RECORD_LIMIT} records`);
    }
    const token = repairToken(rows, occurrences);
    const statements = rows.map((row) => this.db.prepare(`INSERT INTO catalog_admission_repair_stage
      (token, job_id, original_value, proposed_value, url_key, fingerprint_key, sms_pending, digest_pending,
       catalog_state, catalog_sort_key, search_text, source_classes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token, job_id) DO UPDATE SET original_value=excluded.original_value, proposed_value=excluded.proposed_value,
        url_key=excluded.url_key, fingerprint_key=excluded.fingerprint_key, sms_pending=excluded.sms_pending,
        digest_pending=excluded.digest_pending, catalog_state=excluded.catalog_state, catalog_sort_key=excluded.catalog_sort_key,
        search_text=excluded.search_text, source_classes=excluded.source_classes, created_at=excluded.created_at`)
      .bind(token, row.jobId, row.original, row.proposed, row.job.normalizedUrl, row.job.fingerprint,
        Number(row.job.notification.smsPending && alertEligible(row.job)), Number(row.job.notification.digestPending && alertEligible(row.job)),
        catalogEligible(row.job) ? row.job.open ? 'OPEN' : 'CLOSED' : null,
        catalogEligible(row.job) ? row.job.open ? openCatalogSortKey(row.job) : `${row.job.lastSeenAt}#${row.job.jobId}` : null,
        catalogEligible(row.job) ? catalogSearchText(row.job) : null,
        catalogEligible(row.job) ? JSON.stringify(catalogSourceClasses(row.job)) : null, createdAt));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const occurrenceStatements = occurrences.map((row) => this.db.prepare(`INSERT INTO catalog_admission_occurrence_repair_stage
      (token, source_id, external_id, original_value, proposed_value, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token, source_id, external_id) DO UPDATE SET original_value=excluded.original_value,
        proposed_value=excluded.proposed_value, created_at=excluded.created_at`)
      .bind(token, row.sourceId, row.externalId, row.original, row.proposed, createdAt));
    for (let offset = 0; offset < occurrenceStatements.length; offset += 50) await this.db.batch(occurrenceStatements.slice(offset, offset + 50));
    return { repairToken: token, changed: rows.length, candidates: rows.map((row) => row.jobId),
      occurrencesChanged: occurrences.length, occurrenceCandidates: occurrences.map((row) => `${row.sourceId}:${row.externalId}`) };
  }

  async applyRepair(token: string, expectedChanged: number, appliedAt: string, expectedOccurrencesChanged = 0): Promise<{
    changed: number; occurrencesChanged: number; projectionRefreshRequired: boolean; verificationMismatches: number;
  }> {
    const stage = await this.db.prepare('SELECT * FROM catalog_admission_repair_stage WHERE token = ? ORDER BY job_id')
      .bind(token).all<{ job_id: string; original_value: string; proposed_value: string; url_key: string; fingerprint_key: string; sms_pending: number; digest_pending: number; catalog_state: string | null; catalog_sort_key: string | null; search_text: string | null; source_classes: string | null }>();
    if (stage.results.length !== expectedChanged) throw new Error('Repair row count changed; run the dry-run again');
    const occurrenceStage = await this.db.prepare(`SELECT * FROM catalog_admission_occurrence_repair_stage
      WHERE token = ? ORDER BY source_id, external_id`).bind(token)
      .all<{ source_id: string; external_id: string; original_value: string; proposed_value: string }>();
    if (occurrenceStage.results.length !== expectedOccurrencesChanged) throw new Error('Repair occurrence count changed; run the dry-run again');
    if (stage.results.length + occurrenceStage.results.length > ATOMIC_REPAIR_RECORD_LIMIT) {
      throw new Error(`Admission repair exceeds the atomic D1 limit of ${ATOMIC_REPAIR_RECORD_LIMIT} records`);
    }
    const guard = this.db.prepare(`INSERT INTO catalog_admission_repair_guards (token, ok, applied_at)
      SELECT ?, CASE WHEN
        (SELECT count(*) FROM catalog_admission_repair_stage WHERE token = ?) = ?
        AND (SELECT count(*) FROM catalog_admission_occurrence_repair_stage WHERE token = ?) = ?
        AND NOT EXISTS (
          SELECT 1 FROM catalog_admission_repair_stage AS stage
          LEFT JOIN catalog_items AS item ON item.pk = 'JOB#' || stage.job_id AND item.sk = 'META' AND item.kind = 'internship'
          WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.original_value)
        )
        AND NOT EXISTS (
          SELECT 1 FROM catalog_admission_occurrence_repair_stage AS stage
          LEFT JOIN catalog_items AS item ON item.pk = 'SOURCE#' || stage.source_id
            AND item.sk = 'OCCURRENCE#' || stage.external_id AND item.kind = 'source-occurrence'
          WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.original_value)
        ) THEN 1 ELSE 0 END, ?`)
      .bind(token, token, expectedChanged, token, expectedOccurrencesChanged, token, token, appliedAt);
    const updates = stage.results.map((row) => this.db.prepare(`UPDATE catalog_items SET value = ?,
      url_key = ?, fingerprint_key = ?, sms_pending = ?, digest_pending = ?, catalog_state = ?,
      catalog_sort_key = ?, search_text = ?, source_classes = ?
      WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND value = ?
        AND EXISTS (SELECT 1 FROM catalog_admission_repair_guards WHERE token = ? AND ok = 1)`)
      .bind(row.proposed_value, row.url_key, row.fingerprint_key, row.sms_pending, row.digest_pending,
        row.catalog_state, row.catalog_sort_key, row.search_text, row.source_classes,
        `JOB#${row.job_id}`, row.original_value, token));
    const occurrenceUpdates = occurrenceStage.results.map((row) => this.db.prepare(`UPDATE catalog_items SET value = ?
      WHERE pk = ? AND sk = ? AND kind = 'source-occurrence' AND value = ?
        AND EXISTS (SELECT 1 FROM catalog_admission_repair_guards WHERE token = ? AND ok = 1)`)
      .bind(row.proposed_value, `SOURCE#${row.source_id}`, `OCCURRENCE#${row.external_id}`, row.original_value, token));
    await this.db.batch([guard, ...updates, ...occurrenceUpdates]);
    const jobMismatches = await this.db.prepare(`SELECT count(*) AS count FROM catalog_admission_repair_stage AS stage
      LEFT JOIN catalog_items AS item ON item.pk = 'JOB#' || stage.job_id AND item.sk = 'META' AND item.kind = 'internship'
      WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.proposed_value)`).bind(token).first<{ count: number }>();
    const occurrenceMismatches = await this.db.prepare(`SELECT count(*) AS count FROM catalog_admission_occurrence_repair_stage AS stage
      LEFT JOIN catalog_items AS item ON item.pk = 'SOURCE#' || stage.source_id
        AND item.sk = 'OCCURRENCE#' || stage.external_id AND item.kind = 'source-occurrence'
      WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.proposed_value)`).bind(token).first<{ count: number }>();
    const verificationMismatches = (jobMismatches?.count ?? 0) + (occurrenceMismatches?.count ?? 0);
    if (verificationMismatches) throw new Error(`Admission repair verification found ${verificationMismatches} mismatches`);
    await this.db.batch([
      this.db.prepare('DELETE FROM catalog_admission_repair_stage WHERE token = ?').bind(token),
      this.db.prepare('DELETE FROM catalog_admission_occurrence_repair_stage WHERE token = ?').bind(token),
    ]);
    return { changed: stage.results.length, occurrencesChanged: occurrenceStage.results.length,
      projectionRefreshRequired: stage.results.length > 0, verificationMismatches };
  }
}
