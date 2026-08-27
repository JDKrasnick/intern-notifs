import { createHash } from 'node:crypto';
import { canonicalCatalogRecency, catalogRecency, catalogVisibleAt, compareCatalogRecency, openCatalogSortKey } from '../src/catalog-recency.js';
import { catalogSearchText, catalogSourceClasses } from '../src/catalog-fields.js';
import { isPastSeason } from '../src/core/early-career.js';
import { employerCategory } from '../src/core/employers.js';
import type { ApplicationSession } from '../src/application-automation.js';
import { resolvePostingAliases, type AliasResolution } from '../src/identity/posting.js';
import { deletedUserTombstoneKey, type InternshipStore, type LeverAdmission, type ReleaseStore, type UserStore, type CatalogQuery } from '../src/store.js';
import { filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter, type CatalogProjectionPage, type CatalogRelease } from '../src/catalog-groups.js';
import type { ApplicantProfile, ApplicationRecord, DeliveryReceipt, DeviceToken, Internship, MonitoringChecklist, NotificationEvent, PostingIdentity, SourceCheckpoint, SourceHealth, SourceOccurrenceState, UserDocument, UserPreferences } from '../src/types.js';
import type { D1Database } from './types.js';

type JsonRow = { value: string };
const deliveryReceiptLifetimeSeconds = 90 * 24 * 60 * 60;
const documentUploadLeaseSeconds = 15 * 60;

function receiptExpiry(value: Pick<DeliveryReceipt, 'updatedAt'>): number {
  return Math.floor(new Date(value.updatedAt).getTime() / 1_000) + deliveryReceiptLifetimeSeconds;
}

/** Applies the published retention schedule to installation-scoped records. */
export async function cleanupExpiredUserData(db: D1Database, now = new Date()): Promise<void> {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const installationLifetimeSeconds = 365 * 24 * 60 * 60;
  await db.batch([
    // Existing installations predate explicit expiry. Start their retention
    // clock at rollout so the migration never surprises an active tester.
    db.prepare("UPDATE user_items SET expires_at = ? WHERE kind = 'installation' AND expires_at IS NULL")
      .bind(nowSeconds + installationLifetimeSeconds),
    db.prepare(`
      UPDATE user_items
      SET expires_at = CAST(strftime('%s', json_extract(value, '$.updatedAt')) AS INTEGER) + ?
      WHERE kind = 'receipt' AND expires_at IS NULL
        AND json_extract(value, '$.updatedAt') IS NOT NULL
    `).bind(deliveryReceiptLifetimeSeconds),
    db.prepare("UPDATE user_items SET expires_at = ? WHERE kind = 'receipt' AND expires_at IS NULL")
      .bind(nowSeconds + deliveryReceiptLifetimeSeconds),
    db.prepare(`
      DELETE FROM user_items
      WHERE user_id IN (
        SELECT user_id FROM user_items
        WHERE kind = 'installation' AND expires_at <= ?
      )
    `).bind(nowSeconds),
    db.prepare("DELETE FROM user_items WHERE kind <> 'installation' AND expires_at IS NOT NULL AND expires_at <= ?")
      .bind(nowSeconds),
  ]);
}

function parse<T>(row: JsonRow | null): T | undefined {
  return row ? JSON.parse(row.value) as T : undefined;
}

function withEmployerCategory(job: Internship): Internship {
  const canonical = canonicalCatalogRecency(job);
  return { ...canonical, employerCategory: canonical.employerCategory ?? employerCategory(canonical.company) };
}

function cursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function likePattern(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export class D1InternshipStore implements InternshipStore {
  constructor(private readonly db: D1Database) {}

  private async get<T>(pk: string, sk: string): Promise<T | undefined> {
    return parse<T>(await this.db.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?').bind(pk, sk).first<JsonRow>());
  }

  private async put(pk: string, sk: string, kind: string, value: unknown, columns: Record<string, string | number | null> = {}): Promise<void> {
    const names = Object.keys(columns);
    const placeholders = Array.from({ length: 4 + names.length }, () => '?').join(', ');
    const updates = ['kind = excluded.kind', 'value = excluded.value', ...names.map((name) => `${name} = excluded.${name}`)].join(', ');
    await this.db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value${names.length ? `, ${names.join(', ')}` : ''}) VALUES (${placeholders}) ON CONFLICT(pk, sk) DO UPDATE SET ${updates}`)
      .bind(pk, sk, kind, JSON.stringify(value), ...names.map((name) => columns[name])).run();
  }

  private internshipStatement(job: Internship) {
    const canonical = canonicalCatalogRecency(job);
    return this.db.prepare(`
      INSERT INTO catalog_items (
        pk, sk, kind, value, url_key, fingerprint_key, sms_pending, digest_pending,
        catalog_state, catalog_sort_key, search_text, source_classes
      ) VALUES (?, 'META', 'internship', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
        url_key = excluded.url_key, fingerprint_key = excluded.fingerprint_key,
        sms_pending = excluded.sms_pending, digest_pending = excluded.digest_pending,
        catalog_state = excluded.catalog_state, catalog_sort_key = excluded.catalog_sort_key,
        search_text = excluded.search_text, source_classes = excluded.source_classes
    `).bind(
      `JOB#${canonical.jobId}`,
      JSON.stringify(canonical),
      canonical.normalizedUrl,
      canonical.fingerprint,
      canonical.notification.smsPending ? 1 : 0,
      canonical.notification.digestPending ? 1 : 0,
      canonical.technical === false ? null : canonical.open ? 'OPEN' : 'CLOSED',
      canonical.technical === false ? null : canonical.open ? openCatalogSortKey(canonical) : `${canonical.lastSeenAt}#${canonical.jobId}`,
      canonical.technical === false ? null : catalogSearchText(canonical),
      canonical.technical === false ? null : JSON.stringify(catalogSourceClasses(canonical)),
    );
  }

  getCheckpoint(sourceId: string) { return this.get<SourceCheckpoint>(`SOURCE#${sourceId}`, 'CHECKPOINT'); }
  putCheckpoint(checkpoint: SourceCheckpoint) { return this.put(`SOURCE#${checkpoint.sourceId}`, 'CHECKPOINT', 'checkpoint', checkpoint); }
  getSourceHealth(sourceId: string) { return this.get<SourceHealth>(`SOURCE#${sourceId}`, 'HEALTH'); }
  putSourceHealth(health: SourceHealth) { return this.put(`SOURCE#${health.sourceId}`, 'HEALTH', 'source-health', health); }
  async getSourceHealthMany(sourceIds: string[]): Promise<SourceHealth[]> {
    if (!sourceIds.length) return [];
    const health: SourceHealth[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      const chunk = sourceIds.slice(offset, offset + 100);
      const rows = await this.db.prepare(`SELECT value FROM catalog_items WHERE sk = 'HEALTH' AND pk IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk.map((id) => `SOURCE#${id}`)).all<JsonRow>();
      health.push(...rows.results.map((row) => JSON.parse(row.value) as SourceHealth));
    }
    return health;
  }
  getMonitoringChecklist(period: string) { return this.get<MonitoringChecklist>('OPERATIONS#MONITORING', `CHECKLIST#${period}`); }
  putMonitoringChecklist(checklist: MonitoringChecklist) { return this.put('OPERATIONS#MONITORING', `CHECKLIST#${checklist.period}`, 'monitoring-checklist', checklist); }

  async findByUrl(url: string): Promise<Internship | undefined> {
    const job = parse<Internship>(await this.db.prepare('SELECT value FROM catalog_items WHERE url_key = ? LIMIT 1').bind(url).first<JsonRow>());
    return job && withEmployerCategory(job);
  }
  async findByFingerprint(fingerprint: string): Promise<Internship | undefined> {
    const job = parse<Internship>(await this.db.prepare('SELECT value FROM catalog_items WHERE fingerprint_key = ? LIMIT 1').bind(fingerprint).first<JsonRow>());
    return job && withEmployerCategory(job);
  }
  private async postingAliasClaims(aliases: string[]): Promise<Map<string, string>> {
    const claims = new Map<string, string>();
    for (let offset = 0; offset < aliases.length; offset += 100) {
      const chunk = aliases.slice(offset, offset + 100);
      const rows = await this.db.prepare(`SELECT value FROM catalog_items WHERE kind = 'posting-alias' AND pk IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk.map((alias) => `POSTING_ALIAS#${alias}`)).all<JsonRow>();
      for (const row of rows.results) {
        const claim = JSON.parse(row.value) as { alias: string; canonicalJobId: string };
        claims.set(claim.alias, claim.canonicalJobId);
      }
    }
    return claims;
  }
  async claimPostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
    const initial = resolvePostingAliases(identity, await this.postingAliasClaims(aliases));
    if (initial.outcome === 'quarantine') return initial;
    if (preferredJobId && initial.outcome === 'merge' && initial.canonicalJobId !== preferredJobId) {
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [initial.canonicalJobId, preferredJobId].sort(), reason: 'aliases-resolve-to-different-jobs' };
    }
    const canonicalJobId = initial.outcome === 'create' && preferredJobId ? preferredJobId : initial.canonicalJobId;
    const aliasKeys = aliases.map((alias) => `POSTING_ALIAS#${alias}`);
    const conflictingClaim = `NOT EXISTS (
      SELECT 1 FROM catalog_items
      WHERE kind = 'posting-alias'
        AND pk IN (${aliasKeys.map(() => '?').join(', ')})
        AND json_extract(value, '$.canonicalJobId') <> ?
    )`;
    // D1 batches are transactional. Every insert checks the complete alias set,
    // so a competing canonical claim prevents partial claims from poisoning the
    // remaining aliases before the verification read.
    const statements = aliases.map((alias) => this.db.prepare(`
      INSERT INTO catalog_items (pk, sk, kind, value)
      SELECT ?, 'CLAIM', 'posting-alias', ? WHERE ${conflictingClaim}
      ON CONFLICT(pk, sk) DO NOTHING
    `).bind(
      `POSTING_ALIAS#${alias}`,
      JSON.stringify({ alias, canonicalJobId, claimedAt: new Date().toISOString() }),
      ...aliasKeys,
      canonicalJobId,
    ));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const verified = resolvePostingAliases(identity, await this.postingAliasClaims(aliases));
    if (verified.outcome === 'quarantine' || verified.canonicalJobId !== canonicalJobId) {
      const conflicts = verified.outcome === 'quarantine' ? verified.conflictingCanonicalJobIds : [verified.canonicalJobId, canonicalJobId].sort();
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: conflicts, reason: 'aliases-resolve-to-different-jobs' };
    }
    return { ...initial, canonicalJobId };
  }
  async putInternship(job: Internship): Promise<void> {
    await this.internshipStatement(job).run();
  }
  async getJob(jobId: string) {
    const direct = await this.get<Internship>(`JOB#${jobId}`, 'META');
    if (direct) return withEmployerCategory(direct);
    const alias = await this.get<{ canonicalJobId: string }>(`JOB_ID_ALIAS#${jobId}`, 'TARGET');
    if (!alias?.canonicalJobId || alias.canonicalJobId === jobId) return undefined;
    const canonical = await this.get<Internship>(`JOB#${alias.canonicalJobId}`, 'META');
    return canonical && withEmployerCategory(canonical);
  }
  async getSourceOccurrences(sourceId: string): Promise<SourceOccurrenceState[]> {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk LIKE 'OCCURRENCE#%'").bind(`SOURCE#${sourceId}`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as SourceOccurrenceState);
  }
  putSourceOccurrence(occurrence: SourceOccurrenceState) {
    return this.put(`SOURCE#${occurrence.sourceId}`, `OCCURRENCE#${occurrence.externalId}`, 'source-occurrence', occurrence, { source_id: occurrence.sourceId, external_id: occurrence.externalId });
  }
  async putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent): Promise<boolean> {
    const eventStatement = this.db.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'EVENT', 'notification-event', ?) ON CONFLICT(pk, sk) DO NOTHING")
      .bind(`OUTBOX#${event.eventId}`, JSON.stringify(event));
    const [eventResult] = await this.db.batch([eventStatement, this.internshipStatement(job)]);
    return eventResult.meta.changes > 0;
  }
  private async pending(column: 'sms_pending' | 'digest_pending'): Promise<Internship[]> {
    const result = await this.db.prepare(`SELECT value FROM catalog_items WHERE ${column} = 1 AND catalog_state = 'OPEN'`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as Internship);
  }
  pendingSms() { return this.pending('sms_pending'); }
  pendingDigest() { return this.pending('digest_pending'); }
  async markSmsSent(jobId: string, sentAt: string) { const job = await this.getJob(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; await this.putInternship(job); } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = await this.getJob(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; await this.putInternship(job); } } }

  /**
   * Guarded recovery for notification events consumed while no Expo recipient
   * existed. Existing per-device receipts always win, so accepted or failed
   * deliveries are never replayed by this operation.
   */
  async recoverUndeliveredNotifications(input: {
    since: string;
    limit: number;
    apply: boolean;
    expectedCandidateJobIds?: string[];
  }): Promise<{ candidates: number; candidateJobIds: string[]; requeued: number }> {
    const result = await this.db.prepare(`
      SELECT json_extract(event.value, '$.jobId') AS jobId
      FROM catalog_items AS event
      JOIN catalog_items AS job
        ON job.pk = 'JOB#' || json_extract(event.value, '$.jobId') AND job.sk = 'META'
      WHERE event.kind = 'notification-event'
        AND json_extract(event.value, '$.createdAt') >= ?
        AND job.kind = 'internship'
        AND job.catalog_state = 'OPEN'
        AND job.sms_pending = 0
        AND NOT EXISTS (
          SELECT 1 FROM user_items AS receipt
          WHERE receipt.kind = 'receipt'
            AND json_extract(receipt.value, '$.jobId') = json_extract(event.value, '$.jobId')
        )
      GROUP BY job.pk
      ORDER BY MAX(json_extract(event.value, '$.createdAt')) DESC, job.pk ASC
      LIMIT ?
    `).bind(input.since, input.limit).all<{ jobId: string }>();
    const candidates = result.results.map(({ jobId }) => jobId);
    if (!input.apply) return { candidates: candidates.length, candidateJobIds: candidates, requeued: 0 };
    if (!input.expectedCandidateJobIds
      || input.expectedCandidateJobIds.length !== candidates.length
      || input.expectedCandidateJobIds.some((jobId, index) => jobId !== candidates[index])) {
      throw new Error('Notification recovery candidate set changed; preview again before applying');
    }
    const statements = candidates.map((jobId) => this.db.prepare(`
      UPDATE catalog_items
      SET value = json_set(json_remove(value, '$.notification.smsSentAt'), '$.notification.smsPending', json('true')),
          sms_pending = 1
      WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND catalog_state = 'OPEN' AND sms_pending = 0
        AND NOT EXISTS (
          SELECT 1 FROM user_items AS receipt
          WHERE receipt.kind = 'receipt' AND json_extract(receipt.value, '$.jobId') = ?
        )
    `).bind(`JOB#${jobId}`, jobId));
    const updates = statements.length ? await this.db.batch(statements) : [];
    return {
      candidates: candidates.length,
      candidateJobIds: candidates,
      requeued: updates.reduce((total, update) => total + update.meta.changes, 0),
    };
  }

  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open', query: CatalogQuery = {}): Promise<{ jobs: Internship[]; cursor?: string }> {
    const offset = cursorOffset(cursor);
    const clauses = ['catalog_state = ?'];
    const values: unknown[] = [status === 'open' ? 'OPEN' : 'CLOSED'];
    const needle = query.query?.trim().toLowerCase();
    if (needle) { clauses.push('search_text LIKE ?'); values.push(`%${needle}%`); }
    if (query.source && query.source !== 'all') { clauses.push('source_classes LIKE ?'); values.push(`%"${query.source}"%`); }
    const jobs: Internship[] = [];
    const batchSize = Math.max(50, limit * 2);
    let scanned = offset;
    while (true) {
      const result = await this.db.prepare(`SELECT value FROM catalog_items WHERE ${clauses.join(' AND ')} ORDER BY catalog_sort_key DESC LIMIT ? OFFSET ?`)
        .bind(...values, batchSize, scanned).all<JsonRow>();
      for (const row of result.results) {
        const rowOffset = scanned;
        scanned += 1;
        const job = withEmployerCategory(JSON.parse(row.value) as Internship);
        if (isPastSeason(job.season)) continue;
        if (jobs.length === limit) return { jobs, cursor: String(rowOffset) };
        jobs.push(job);
      }
      if (result.results.length < batchSize) return { jobs };
    }
  }
  async listOpenSince(after: string, before: string): Promise<Internship[]> {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE catalog_state = 'OPEN' AND catalog_sort_key > ? AND catalog_sort_key <= ? ORDER BY catalog_sort_key DESC")
      .bind(`3#${after}`, `3#${before}\uffff`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as Internship)
      .filter((job) => catalogRecency(job) === 'normal' && catalogVisibleAt(job) > after && catalogVisibleAt(job) <= before && !isPastSeason(job.season))
      .sort(compareCatalogRecency).map(withEmployerCategory);
  }
  async listCatalog(): Promise<Internship[]> {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship'").all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as Internship)
      .filter((job) => job.technical !== false && !isPastSeason(job.season))
      .sort(compareCatalogRecency).map(withEmployerCategory);
  }
  async putCatalogProjection(groups: CatalogGroupDetails[], generatedAt: string): Promise<void> {
    const previous = await this.get<{ version: string }>('CATALOG_PROJECTION', 'CURRENT');
    const version = createHash('sha256').update(`${generatedAt}\0${groups.map((group) => group.group.groupId).join('\0')}`).digest('hex').slice(0, 20);
    const statements = groups.map((details, index) => this.db.prepare(`
      INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, 'catalog-projection', ?, ?)
      ON CONFLICT(pk, sk) DO UPDATE SET value = excluded.value, catalog_sort_key = excluded.catalog_sort_key
    `).bind(`CATALOG_PROJECTION#${version}`, `GROUP#${details.group.groupId}`, JSON.stringify(details), String(index).padStart(8, '0')));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    await this.put('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', { version, generatedAt, schemaVersion: 3 });
    // Projection versions are rebuildable caches. Deleting only the version
    // observed before this refresh keeps overlapping refreshes from deleting
    // whichever version wins the pointer race.
    if (previous?.version && previous.version !== version) {
      await this.db.prepare("DELETE FROM catalog_items WHERE kind = 'catalog-projection' AND pk = ?")
        .bind(`CATALOG_PROJECTION#${previous.version}`).run();
    }
  }
  async listCatalogProjection(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.get<{ version: string; generatedAt: string; schemaVersion: number }>('CATALOG_PROJECTION', 'CURRENT');
    if (!pointer || pointer.schemaVersion !== 3 || Date.now() - Date.parse(pointer.generatedAt) > 24 * 60 * 60 * 1_000) return undefined;
    const offset = cursorOffset(cursor);
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND kind = 'catalog-projection' ORDER BY catalog_sort_key ASC LIMIT ? OFFSET ?")
      .bind(`CATALOG_PROJECTION#${pointer.version}`, limit + 1, offset).all<JsonRow>();
    const groups = rows.results.slice(0, limit).map((row) => JSON.parse(row.value) as CatalogGroupDetails);
    return { groups, ...(rows.results.length > limit ? { cursor: String(offset + limit) } : {}) };
  }
  async listCatalogProjectionFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.get<{ version: string; generatedAt: string; schemaVersion: number }>('CATALOG_PROJECTION', 'CURRENT');
    if (!pointer || pointer.schemaVersion !== 3 || Date.now() - Date.parse(pointer.generatedAt) > 24 * 60 * 60 * 1_000) return undefined;
    const offset = cursorOffset(cursor);
    const roleClauses = ["json_extract(role.value, '$.open') = ?"];
    const values: unknown[] = [filter.status === 'closed' ? 0 : 1];
    if (filter.query?.trim()) {
      roleClauses.push(`lower(
        coalesce(json_extract(role.value, '$.company'), '') || ' ' ||
        coalesce(json_extract(role.value, '$.title'), '') || ' ' ||
        coalesce(json_extract(role.value, '$.location'), '') || ' ' ||
        coalesce(json_extract(role.value, '$.season'), '')
      ) LIKE ? ESCAPE '\\'`);
      values.push(likePattern(filter.query.trim()));
    }
    if (filter.source && filter.source !== 'all') {
      const credibility = filter.source === 'direct'
        ? ['official', 'corroborated']
        : filter.source === 'community'
          ? ['community', 'corroborated']
          : ['corroborated'];
      roleClauses.push(`json_extract(role.value, '$.sourceCredibility') IN (${placeholders(credibility)})`);
      values.push(...credibility);
    }
    if (filter.employerCategories?.length) {
      roleClauses.push(`json_extract(role.value, '$.employerCategory') IN (${placeholders(filter.employerCategories)})`);
      values.push(...filter.employerCategories);
    }
    if (filter.hideUsCitizenshipRequired) roleClauses.push("coalesce(json_extract(role.value, '$.requiresUsCitizenship'), 0) = 0");
    if (filter.hideAdvancedDegreeRequired) roleClauses.push("coalesce(json_extract(role.value, '$.advancedDegreeRequired'), 0) = 0");
    const exactArrayFilter = (path: string, requested: string[]) => {
      const normalized = requested.map((value) => value.toLowerCase());
      roleClauses.push(`EXISTS (SELECT 1 FROM json_each(role.value, '${path}') AS item WHERE lower(item.value) IN (${placeholders(normalized)}))`);
      values.push(...normalized);
    };
    if (filter.disciplines?.length) exactArrayFilter('$.disciplines', filter.disciplines);
    if (filter.seasons?.length) {
      const normalized = filter.seasons.map((value) => value.toLowerCase());
      roleClauses.push(`lower(json_extract(role.value, '$.season')) IN (${placeholders(normalized)})`);
      values.push(...normalized);
    }
    if (filter.educationLevels?.length) {
      const normalized = filter.educationLevels.map((value) => value.toLowerCase());
      roleClauses.push(`(
        json_extract(role.value, '$.education.evidence') = 'unspecified'
        OR EXISTS (SELECT 1 FROM json_each(role.value, '$.education.levels') AS level WHERE lower(level.value) IN (${placeholders(normalized)}))
      )`);
      values.push(...normalized);
    }
    if (filter.workModes?.length) exactArrayFilter('$.workModes', filter.workModes);
    if (filter.locations?.length) {
      const patterns = filter.locations.map(likePattern);
      const searchableLocations = `CASE
        WHEN json_type(role.value, '$.locations') = 'array' THEN coalesce((
          SELECT group_concat(location.value, ' ')
          FROM json_each(role.value, '$.locations') AS location
        ), '')
        ELSE coalesce(json_extract(role.value, '$.location'), '')
      END`;
      roleClauses.push(`(${patterns.map(() => `lower(${searchableLocations}) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      values.push(...patterns);
    }
    const rows = await this.db.prepare(`
      SELECT projection.value
      FROM catalog_items AS projection
      WHERE projection.pk = ?
        AND projection.kind = 'catalog-projection'
        AND EXISTS (
          SELECT 1 FROM json_each(projection.value, '$.roles') AS role
          WHERE ${roleClauses.join('\n            AND ')}
        )
      ORDER BY projection.catalog_sort_key ASC
      LIMIT ? OFFSET ?
    `).bind(`CATALOG_PROJECTION#${pointer.version}`, ...values, limit + 1, offset).all<JsonRow>();
    const candidates = rows.results.slice(0, limit).map((row) => JSON.parse(row.value) as CatalogGroupDetails);
    const groups = filterCatalogGroupDetails(candidates, filter);
    return { groups, ...(rows.results.length > limit ? { cursor: String(offset + limit) } : {}) };
  }
  async getCatalogProjectionGroup(groupId: string): Promise<CatalogGroupDetails | undefined> {
    const pointer = await this.get<{ version: string; generatedAt: string; schemaVersion: number }>('CATALOG_PROJECTION', 'CURRENT');
    if (!pointer || pointer.schemaVersion !== 3 || Date.now() - Date.parse(pointer.generatedAt) > 24 * 60 * 60 * 1_000) return undefined;
    return this.get<CatalogGroupDetails>(`CATALOG_PROJECTION#${pointer.version}`, `GROUP#${groupId}`);
  }
  async listLeverAdmissions(): Promise<LeverAdmission[]> {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = 'REGISTRY#LEVER' AND sk LIKE 'SOURCE#%'").all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as LeverAdmission);
  }
  async putLeverAdmission(admission: LeverAdmission): Promise<void> {
    const result = await this.db.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('REGISTRY#LEVER', ?, 'lever-admission', ?) ON CONFLICT(pk, sk) DO NOTHING")
      .bind(`SOURCE#${admission.source.site}`, JSON.stringify(admission)).run();
    if (result.meta.changes === 0) throw new Error(`Lever site ${admission.source.site} is already admitted`);
  }
}

export class D1UserStore implements UserStore {
  constructor(private readonly db: D1Database) {}

  private deletionOwner(userId: string) { return deletedUserTombstoneKey(userId).pk; }
  async beginUserDeletion(userId: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      VALUES (?, 'TOMBSTONE', 'deleted-user-tombstone', '{}')
      ON CONFLICT(user_id, item_key) DO NOTHING
    `).bind(this.deletionOwner(userId)).run();
  }
  async isUserDeletionPending(userId: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 AS present FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE'")
      .bind(this.deletionOwner(userId)).first<{ present: number }>());
  }
  async beginDocumentUpload(userId: string, documentId: string, leaseId: string, now = new Date()): Promise<boolean> {
    const expires = Math.floor(now.getTime() / 1_000) + documentUploadLeaseSeconds;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, expires_at)
      SELECT ?, ?, 'document-upload', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
      WHERE user_items.expires_at <= ?
    `).bind(userId, `DOCUMENT_UPLOAD#${documentId}`, JSON.stringify(leaseId), expires, this.deletionOwner(userId), Math.floor(now.getTime() / 1_000)).run();
    return result.meta.changes > 0;
  }
  async finishDocumentUpload(userId: string, documentId: string, leaseId: string): Promise<void> {
    await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ? AND value = ?')
      .bind(userId, `DOCUMENT_UPLOAD#${documentId}`, JSON.stringify(leaseId)).run();
  }
  async hasActiveDocumentUploads(userId: string, now = new Date()): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 AS present FROM user_items WHERE user_id = ? AND kind = 'document-upload' AND expires_at > ? LIMIT 1")
      .bind(userId, Math.floor(now.getTime() / 1_000)).first<{ present: number }>());
  }

  private async get<T>(userId: string, key: string): Promise<T | undefined> {
    return parse<T>(await this.db.prepare('SELECT value FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, key).first<JsonRow>());
  }
  private async put(userId: string, key: string, kind: string, value: unknown, columns: Record<string, string | number | null> = {}): Promise<void> {
    const names = Object.keys(columns);
    const updates = ['kind = excluded.kind', 'value = excluded.value', ...names.map((name) => `${name} = excluded.${name}`)].join(', ');
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value${names.length ? `, ${names.join(', ')}` : ''})
      SELECT ${Array.from({ length: 4 + names.length }, () => '?').join(', ')}
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO UPDATE SET ${updates}
    `).bind(userId, key, kind, JSON.stringify(value), ...names.map((name) => columns[name]), this.deletionOwner(userId)).run();
    if (result.meta.changes === 0) throw new Error('Account deletion is in progress');
  }
  private async list<T>(userId: string, prefix: string): Promise<T[]> {
    const result = await this.db.prepare('SELECT value FROM user_items WHERE user_id = ? AND item_key LIKE ?').bind(userId, `${prefix}%`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as T);
  }
  getPreferences(userId: string) { return this.get<UserPreferences>(userId, 'PREFERENCES'); }
  putPreferences(value: UserPreferences) { return this.put(value.userId, 'PREFERENCES', 'preferences', value); }
  async activePreferences(): Promise<UserPreferences[]> {
    const rows = await this.db.prepare("SELECT value FROM user_items WHERE kind = 'preferences' AND json_extract(value, '$.alertsEnabled') = 1 AND json_extract(value, '$.onboardingComplete') = 1").all<JsonRow>();
    return rows.results.map((row) => JSON.parse(row.value) as UserPreferences);
  }
  async activeDevices(): Promise<DeviceToken[]> { const rows = await this.db.prepare('SELECT value FROM user_items WHERE active_device = 1').all<JsonRow>(); return rows.results.map((row) => JSON.parse(row.value) as DeviceToken); }
  async putDevice(value: DeviceToken) {
    // One Expo token represents one physical installation. Transfer a token
    // away from any legacy account owner before assigning it to the anonymous
    // installation so the same phone cannot receive duplicate alerts.
    const results = await this.db.batch([
      this.db.prepare(`
        DELETE FROM user_items WHERE kind = 'device' AND device_token = ? AND user_id <> ?
          AND NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      `).bind(value.token, value.userId, this.deletionOwner(value.userId)),
      this.db.prepare(`
        INSERT INTO user_items (user_id, item_key, kind, value, active_device, device_token)
        SELECT ?, ?, 'device', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
        ON CONFLICT(user_id, item_key) DO UPDATE SET
          kind = excluded.kind,
          value = excluded.value,
          active_device = excluded.active_device,
          device_token = excluded.device_token
      `).bind(value.userId, `DEVICE#${value.token}`, JSON.stringify(value), value.active ? 1 : 0, value.token, this.deletionOwner(value.userId)),
    ]);
    if (results[1]?.meta.changes === 0) throw new Error('Account deletion is in progress');
  }
  async deleteDevice(userId: string, token: string) { await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `DEVICE#${token}`).run(); }
  getProfile(userId: string) { return this.get<ApplicantProfile>(userId, 'PROFILE'); }
  putProfile(value: ApplicantProfile) { return this.put(value.userId, 'PROFILE', 'profile', value); }
  async listApplications(userId: string) { return (await this.list<ApplicationRecord>(userId, 'APPLICATION#')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  getApplication(userId: string, applicationId: string) { return this.get<ApplicationRecord>(userId, `APPLICATION#${applicationId}`); }
  putApplication(userId: string, value: ApplicationRecord) { return this.put(userId, `APPLICATION#${value.applicationId}`, 'application', value); }
  getApplicationSession(userId: string, sessionId: string) { return this.get<ApplicationSession>(userId, `APPLICATION_SESSION#${sessionId}`); }
  async getApplicationSessionById(sessionId: string) { return parse<ApplicationSession>(await this.db.prepare('SELECT value FROM user_items WHERE session_id = ? LIMIT 1').bind(sessionId).first<JsonRow>()); }
  async putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number): Promise<boolean> {
    const key = `APPLICATION_SESSION#${value.sessionId}`;
    const active = !['submitted', 'failed', 'cancelled'].includes(value.status) ? value.sessionId : null;
    const expires = Math.floor(new Date(value.metadataExpiresAt).getTime() / 1000);
    if (expectedVersion === undefined) {
      const result = await this.db.prepare(`
        INSERT INTO user_items (user_id, item_key, kind, value, session_id, expires_at)
        SELECT ?, ?, 'application-session', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
        ON CONFLICT(user_id, item_key) DO NOTHING
      `).bind(userId, key, JSON.stringify(value), active, expires, this.deletionOwner(userId)).run();
      return result.meta.changes > 0;
    }
    const result = await this.db.prepare(`
      UPDATE user_items SET value = ?, session_id = ?, expires_at = ?
      WHERE user_id = ? AND item_key = ? AND CAST(json_extract(value, '$.version') AS INTEGER) = ?
        AND NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
    `).bind(JSON.stringify(value), active, expires, userId, key, expectedVersion, this.deletionOwner(userId)).run();
    return result.meta.changes > 0;
  }
  async listApplicationSessions(userId: string, applicationId?: string) { return (await this.list<ApplicationSession>(userId, 'APPLICATION_SESSION#')).filter((session) => !applicationId || session.applicationId === applicationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  listDocuments(userId: string) { return this.list<UserDocument>(userId, 'DOCUMENT#'); }
  async putDocument(value: UserDocument): Promise<void> {
    const key = `DOCUMENT#${value.documentId}`;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      SELECT ?, ?, 'document', ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
        AND (EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = ?)
         OR ((SELECT COUNT(*) FROM user_items WHERE kind = 'document') < 100
         AND (SELECT COUNT(*) FROM user_items WHERE kind = 'document' AND user_id = ?) < 5))
      ON CONFLICT(user_id, item_key) DO UPDATE SET value = excluded.value
    `).bind(value.userId, key, JSON.stringify(value), this.deletionOwner(value.userId), value.userId, key, value.userId).run();
    if (result.meta.changes === 0) throw new Error(await this.isUserDeletionPending(value.userId) ? 'Account deletion is in progress' : 'Document storage quota reached');
  }
  async claimDocumentUpload(period: string): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT INTO usage_counters (period, metric, count) VALUES (?, 'r2_upload', 1)
      ON CONFLICT(period, metric) DO UPDATE SET count = count + 1 WHERE count < 1000
    `).bind(period).run();
    return result.meta.changes > 0;
  }
  async deleteDocument(userId: string, documentId: string) { await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `DOCUMENT#${documentId}`).run(); }
  getReceipt(userId: string, dedupeKey: string, token: string) { return this.get<DeliveryReceipt>(userId, `RECEIPT#${dedupeKey}#${token}`); }
  async claimReceipt(value: DeliveryReceipt): Promise<boolean> {
    const key = `RECEIPT#${value.dedupeKey ?? value.jobId}#${value.token}`;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at)
      SELECT ?, ?, 'receipt', ?, 'PENDING', ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO UPDATE SET value = excluded.value, receipt_state = excluded.receipt_state, expires_at = excluded.expires_at
      WHERE json_extract(user_items.value, '$.status') = 'error'
    `).bind(value.userId, key, JSON.stringify(value), receiptExpiry(value), this.deletionOwner(value.userId)).run();
    return result.meta.changes > 0;
  }
  putReceipt(value: DeliveryReceipt) { return this.put(value.userId, `RECEIPT#${value.dedupeKey ?? value.jobId}#${value.token}`, 'receipt', value, { receipt_state: value.status === 'pending' ? 'PENDING' : value.status === 'retryable' ? 'RETRYABLE' : null, expires_at: receiptExpiry(value) }); }
  async migrateReceipt(value: DeliveryReceipt, dedupeKey: string): Promise<boolean> {
    const migrated = { ...value, dedupeKey };
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at)
      SELECT ?, ?, 'receipt', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO NOTHING
    `).bind(value.userId, `RECEIPT#${dedupeKey}#${value.token}`, JSON.stringify(migrated), value.status === 'pending' ? 'PENDING' : value.status === 'retryable' ? 'RETRYABLE' : null, receiptExpiry(migrated), this.deletionOwner(value.userId)).run();
    return result.meta.changes > 0;
  }
  async pendingReceipts() { const rows = await this.db.prepare("SELECT value FROM user_items WHERE receipt_state = 'PENDING'").all<JsonRow>(); return rows.results.map((row) => JSON.parse(row.value) as DeliveryReceipt); }
  async retryableReceipts() { const rows = await this.db.prepare("SELECT value FROM user_items WHERE receipt_state = 'RETRYABLE'").all<JsonRow>(); return rows.results.map((row) => JSON.parse(row.value) as DeliveryReceipt); }
  async deleteUser(userId: string): Promise<UserDocument[]> { await this.beginUserDeletion(userId); const documents = await this.listDocuments(userId); await this.db.prepare('DELETE FROM user_items WHERE user_id = ?').bind(userId).run(); return documents; }
}

export class D1ReleaseStore implements ReleaseStore {
  constructor(private readonly db: D1Database) {}

  async getRelease(userId: string, releaseId: string): Promise<CatalogRelease | undefined> {
    return parse<CatalogRelease>(await this.db.prepare('SELECT value FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `RELEASE#${releaseId}`).first<JsonRow>());
  }

  async putRelease(release: CatalogRelease): Promise<void> {
    const deletionOwner = deletedUserTombstoneKey(release.userId).pk;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      SELECT ?, ?, 'catalog-release', ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO NOTHING
    `).bind(release.userId, `RELEASE#${release.releaseId}`, JSON.stringify(release), deletionOwner).run();
    if (result.meta.changes > 0) return;
    const existing = await this.getRelease(release.userId, release.releaseId);
    if (!existing && await this.db.prepare("SELECT 1 AS present FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE'").bind(deletionOwner).first()) return;
    if (JSON.stringify(existing) !== JSON.stringify(release)) throw new Error(`Release identity conflict for ${release.releaseId}`);
  }
}
