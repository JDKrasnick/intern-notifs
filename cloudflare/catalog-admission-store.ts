import { createHash } from 'node:crypto';
import { catalogEligible } from '../src/catalog-admission.js';
import { alertEligible } from '../src/catalog-admission.js';
import { openCatalogSortKey } from '../src/catalog-recency.js';
import { catalogSearchText, catalogSourceClasses } from '../src/catalog-fields.js';
import type {
  AdmissionIncident,
  CanonicalEmployer,
  CatalogAdmission,
  DestinationReviewRule,
  EmployerMapping,
  Internship,
  ProviderIdentity,
} from '../src/types.js';
import type { D1Database } from './types.js';

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
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function repairToken(rows: Array<{ jobId: string; original: string; proposed: string }>): string {
  return createHash('sha256').update(rows.map((row) => `${row.jobId}\0${hash(row.original)}\0${hash(row.proposed)}`).sort().join('\n')).digest('hex');
}

function preserveDurableFields(current: Internship, change: RepairChange): Internship {
  return {
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
    sourceReferences: current.sourceReferences,
    postingIdentity: current.postingIdentity,
    notification: current.notification,
  };
}

export class D1CatalogAdmissionStore {
  constructor(private readonly db: D1Database) {}

  async audit(): Promise<{
    scanned: number;
    eligible: number;
    review: number;
    legacyUnclassified: number;
    byReason: Record<string, number>;
    records: Array<{ jobId: string; company: string; title: string; open: boolean; catalogEligible: boolean; reasonCodes: string[] }>;
  }> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship'").all<JsonRow>();
    const jobs = rows.results.map((row) => JSON.parse(row.value) as Internship);
    const byReason: Record<string, number> = {};
    for (const job of jobs) for (const reason of job.admission?.reasonCodes ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1;
    return {
      scanned: jobs.length,
      eligible: jobs.filter(catalogEligible).length,
      review: jobs.filter((job) => job.admission?.catalogEligible === false).length,
      legacyUnclassified: jobs.filter((job) => !job.admission).length,
      byReason,
      records: jobs.filter((job) => job.admission?.catalogEligible === false).map((job) => ({
        jobId: job.jobId, company: job.company, title: job.title, open: job.open,
        catalogEligible: false, reasonCodes: job.admission?.reasonCodes ?? [],
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
    const scopes = [...new Set([identity.sourceId, identity.tenant].filter((value): value is string => Boolean(value)))];
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

  async markReviewRuleSampled(id: string, sampleDueAt: string): Promise<void> {
    await this.db.prepare('UPDATE destination_review_rules SET sample_due_at = ? WHERE id = ?').bind(sampleDueAt, id).run();
  }

  async listActiveIncidents(): Promise<AdmissionIncident[]> {
    const rows = await this.db.prepare("SELECT * FROM admission_incidents WHERE state = 'open' ORDER BY grace_deadline, opened_at").all<Record<string, unknown>>();
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
      WHERE job_id = ? AND source_id = ? AND state = 'open'${condition}`)
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

  async stageRepair(changes: RepairChange[], createdAt: string): Promise<{ repairToken: string; changed: number; candidates: string[] }> {
    if (!changes.length) return { repairToken: repairToken([]), changed: 0, candidates: [] };
    if (new Set(changes.map((change) => change.jobId)).size !== changes.length) throw new Error('Repair job IDs must be unique');
    const rows: Array<{ jobId: string; original: string; proposed: string; job: Internship }> = [];
    for (const change of changes) {
      const row = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship'")
        .bind(`JOB#${change.jobId}`).first<JsonRow>();
      if (!row) throw new Error(`Repair job ${change.jobId} was not found`);
      const current = JSON.parse(row.value) as Internship;
      const proposed = preserveDurableFields(current, change);
      rows.push({ jobId: change.jobId, original: row.value, proposed: JSON.stringify(proposed), job: proposed });
    }
    const token = repairToken(rows);
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
    return { repairToken: token, changed: rows.length, candidates: rows.map((row) => row.jobId) };
  }

  async applyRepair(token: string, expectedChanged: number, appliedAt: string): Promise<{ changed: number; projectionRefreshRequired: boolean }> {
    const stage = await this.db.prepare('SELECT * FROM catalog_admission_repair_stage WHERE token = ? ORDER BY job_id')
      .bind(token).all<{ job_id: string; original_value: string; proposed_value: string; url_key: string; fingerprint_key: string; sms_pending: number; digest_pending: number; catalog_state: string | null; catalog_sort_key: string | null; search_text: string | null; source_classes: string | null }>();
    if (stage.results.length !== expectedChanged) throw new Error('Repair row count changed; run the dry-run again');
    const guard = this.db.prepare(`INSERT INTO catalog_admission_repair_guards (token, ok, applied_at)
      SELECT ?, CASE WHEN
        (SELECT count(*) FROM catalog_admission_repair_stage WHERE token = ?) = ?
        AND NOT EXISTS (
          SELECT 1 FROM catalog_admission_repair_stage AS stage
          LEFT JOIN catalog_items AS item ON item.pk = 'JOB#' || stage.job_id AND item.sk = 'META' AND item.kind = 'internship'
          WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.original_value)
        ) THEN 1 ELSE 0 END, ?`)
      .bind(token, token, expectedChanged, token, appliedAt);
    const updates = stage.results.map((row) => this.db.prepare(`UPDATE catalog_items SET value = ?,
      url_key = ?, fingerprint_key = ?, sms_pending = ?, digest_pending = ?, catalog_state = ?,
      catalog_sort_key = ?, search_text = ?, source_classes = ?
      WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND value = ?`)
      .bind(row.proposed_value, row.url_key, row.fingerprint_key, row.sms_pending, row.digest_pending,
        row.catalog_state, row.catalog_sort_key, row.search_text, row.source_classes,
        `JOB#${row.job_id}`, row.original_value));
    await this.db.batch([guard, ...updates]);
    await this.db.prepare('DELETE FROM catalog_admission_repair_stage WHERE token = ?').bind(token).run();
    return { changed: stage.results.length, projectionRefreshRequired: stage.results.length > 0 };
  }
}
