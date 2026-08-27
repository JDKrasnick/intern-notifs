import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { runPostingIdentityRepair } from '../src/posting-identity-repair.js';
import type { Internship, ProviderPostingEvidence, SourceOccurrence } from '../src/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;
function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return {
    prepare(query) { return prepared(query); },
    async batch(statements) {
      database.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function database() {
  const value = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0002_cost_guards.sql', '0003_billing_shutdown.sql', '0004_auth_rate_limits.sql', '0005_auth_consent.sql', '0006_employer_channel.sql']) {
    value.exec(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));
  }
  return value;
}

function occurrence(sourceId: string, externalId: string, applyUrl: string, providerEvidence?: ProviderPostingEvidence): SourceOccurrence {
  return {
    sourceId, externalId, document: externalId, sourceUrl: 'https://example.test/source', row: 1,
    company: 'Historical Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, compensation: { raw: '' }, state: 'open', ...(providerEvidence ? { providerEvidence } : {}),
  };
}

function job(jobId: string, applyUrl: string, firstSeenAt: string, sourceReferences: SourceOccurrence[], extra: Record<string, unknown> = {}): Internship {
  return {
    jobId, company: 'Historical Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, normalizedUrl: applyUrl, fingerprint: 'same-soft-fingerprint', compensation: { raw: '' }, sourceReferences,
    open: true, technical: true, firstSeenAt, catalogVisibleAt: firstSeenAt, lastSeenAt: '2026-08-02T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false }, ...extra,
  };
}

const plusId = 'b4f750e7-0148-41f0-b2b1-ff054450a320';
const plusEvidence: ProviderPostingEvidence = {
  provider: 'lever', tenant: 'plus-2', postingId: plusId, sourceId: 'lever-plusai',
  urls: [`https://jobs.lever.co/plus-2/${plusId}`, `https://jobs.lever.co/plus-2/${plusId}/apply`],
};

async function historicalDatabase(options: { presentationAgrees?: boolean } = {}) {
  const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
  await store.putCheckpoint({ sourceId: 'lever-plusai', successfulFetches: 10, activeExternalIds: [plusId] });
  await store.putCheckpoint({ sourceId: 'greenhouse-drweng', successfulFetches: 10, activeExternalIds: ['3413670'] });
  await store.putCheckpoint({ sourceId: 'greenhouse-spacex', successfulFetches: 10, activeExternalIds: ['900001', '900002'] });

  const plusOld = job('plus-old', `https://jobs.lever.co/plus-2/${plusId}`, '2026-07-28T03:12:13.556Z', [
    occurrence('community-list', 'community-plus', `https://jobs.lever.co/plus-2/${plusId}?utm_source=simplify`),
  ], { notification: { smsPending: false, digestPending: false, smsSentAt: '2026-07-28T03:13:00.000Z', digestedAt: '2026-07-28T12:00:00.000Z' } });
  const plusDuplicate = job('plus-duplicate', options.presentationAgrees
    ? `https://jobs.lever.co/plus-2/${plusId}`
    : `https://jobs.lever.co/plus-2/${plusId}/apply`, '2026-08-01T13:44:06.281Z', [
    occurrence('lever-plusai', plusId, `https://jobs.lever.co/plus-2/${plusId}/apply`, plusEvidence),
  ], { notification: { smsPending: true, digestPending: true } });
  const drwEvidence: ProviderPostingEvidence = { provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng', urls: ['https://job-boards.greenhouse.io/drweng/jobs/3413670'] };
  const drwOld = job('drw-old', 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670', '2026-07-20T00:00:00.000Z', [
    occurrence('community-list', 'drw-community', 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?ref=feed'),
  ]);
  const drwDuplicate = job('drw-duplicate', options.presentationAgrees
    ? 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670'
    : 'https://job-boards.greenhouse.io/drweng/jobs/3413670', '2026-07-21T00:00:00.000Z', [
    occurrence('greenhouse-drweng', '3413670', 'https://job-boards.greenhouse.io/drweng/jobs/3413670', drwEvidence),
  ]);
  // Same internal ID is deliberately not identity: these represent the SpaceX/Roblox failure mode.
  const spacexA = job('spacex-a', 'https://job-boards.greenhouse.io/spacex/jobs/900001', '2026-08-03T00:00:00.000Z', [
    occurrence('greenhouse-spacex', '900001', 'https://job-boards.greenhouse.io/spacex/jobs/900001'),
  ], { internalJobId: 'shared-internal-id' });
  const spacexB = job('spacex-b', 'https://job-boards.greenhouse.io/spacex/jobs/900002', '2026-08-03T00:00:00.000Z', [
    occurrence('greenhouse-spacex', '900002', 'https://job-boards.greenhouse.io/spacex/jobs/900002'),
  ], { internalJobId: 'shared-internal-id' });
  const regularA = job('regular-a', 'https://careers.example.test/jobs/backend', '2026-08-04T00:00:00.000Z', [occurrence('community-list', 'regular-a', 'https://careers.example.test/jobs/backend')]);
  const regularB = job('regular-b', 'https://careers.example.test/jobs/frontend', '2026-08-04T00:00:00.000Z', [occurrence('community-list', 'regular-b', 'https://careers.example.test/jobs/frontend')]);
  for (const value of [plusOld, plusDuplicate, drwOld, drwDuplicate, spacexA, spacexB, regularA, regularB]) await store.putInternship(value);
  await store.putSourceOccurrence({ sourceId: 'lever-plusai', externalId: plusId, jobId: 'plus-duplicate', occurrence: plusDuplicate.sourceReferences[0]!, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'a', changedAt: '2026-08-01T13:44:06.281Z' });

  const insertUser = sqlite.prepare('INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, ?, ?)');
  insertUser.run('user-1', 'APPLICATION#saved', 'application', JSON.stringify({ applicationId: 'saved', jobId: 'plus-old', status: 'saved', notes: 'latest note', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z' }));
  insertUser.run('user-1', 'APPLICATION#interview', 'application', JSON.stringify({ applicationId: 'interview', jobId: 'plus-duplicate', status: 'interview', appliedAt: '2026-08-02T12:00:00Z', detection: { source: 'gmail', detectedAt: '2026-08-02T12:00:00Z' }, applyMode: 'official-form', notes: 'interview note', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z' }));
  insertUser.run('user-1', 'APPLICATION_SESSION#session', 'application-session', JSON.stringify({ sessionId: 'session', userId: 'user-1', applicationId: 'saved', jobId: 'plus-old', status: 'created', version: 1, fields: [], fieldPlanDigest: 'x', runnerLifecycle: 'not-started', expiresAt: '2026-09-01T00:00:00Z', metadataExpiresAt: '2026-09-01T00:00:00Z', eventIds: [], createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }));
  insertUser.run('user-1', 'RECEIPT#old-a#token', 'receipt', JSON.stringify({ userId: 'user-1', jobId: 'plus-old', token: 'token', status: 'error', deliveryState: 'definitive-failure', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }));
  insertUser.run('user-1', 'RECEIPT#old-b#token', 'receipt', JSON.stringify({ userId: 'user-1', jobId: 'plus-duplicate', token: 'token', status: 'ok', deliveryState: 'delivered', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z' }));
  insertUser.run('user-1', 'RELEASE#release', 'catalog-release', JSON.stringify({ releaseId: 'release', userId: 'user-1', jobIds: ['plus-old', 'plus-duplicate', 'regular-a'], newJobIds: ['plus-duplicate'], createdAt: '2026-08-02T00:00:00Z' }));
  sqlite.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('OUTBOX#existing', 'EVENT', 'notification-event', ?)").run(JSON.stringify({
    eventId: 'existing', jobId: 'drw-duplicate', kind: 'new-job', createdAt: '2026-08-02T00:00:00.000Z',
  }));
  sqlite.prepare("INSERT INTO employer_organizations (id, name, domain, state, created_at, updated_at) VALUES ('org', 'Org', 'org.test', 'active', '2026-01-01', '2026-01-01')").run();
  sqlite.prepare("INSERT INTO employer_field_proposals (id, organization_id, job_id, field, proposed_value, evidence_at, state, created_by, created_at) VALUES ('proposal', 'org', 'plus-duplicate', 'title', 'Title', '2026-01-01', 'pending-review', 'reviewer', '2026-01-01')").run();
  return { sqlite, db, store };
}

describe('D1 posting identity repair', () => {
  it('finds historical provider duplicates while keeping bad duplicate signals and regular postings separate', async () => {
    const { db } = await historicalDatabase();
    const first = await runPostingIdentityRepair(db); const second = await runPostingIdentityRepair(db);
    expect(first.repairToken).toBe(second.repairToken);
    expect(first).toMatchObject({
      duplicateGroups: 2,
      duplicateJobs: 2,
      eligibleDuplicateGroups: 0,
      unresolvedDuplicateGroups: 2,
      conflicts: [],
      outboxRows: 1,
      applicationMerges: 0,
      proposalRemaps: 0,
    });
    expect(first.presentationDisagreements).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalJobId: 'plus-old', fields: ['destinationUrl'] }),
      expect.objectContaining({ canonicalJobId: 'drw-old', fields: ['destinationUrl'] }),
    ]));
    expect(first.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalJobId: 'plus-old', duplicateJobIds: ['plus-duplicate'] }),
      expect.objectContaining({ canonicalJobId: 'drw-old', duplicateJobIds: ['drw-duplicate'] }),
    ]));
  });

  it('refuses to apply an identity match whose presentation is unresolved', async () => {
    const { db } = await historicalDatabase();
    const dry = await runPostingIdentityRepair(db);
    await expect(runPostingIdentityRepair(db, {
      apply: true,
      repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges,
      expectedDuplicateJobs: dry.duplicateJobs,
    })).rejects.toThrow('unresolved presentation disagreements');
  });

  it('applies exact guarded remaps for presentation-agreeing groups, preserves workflow/notifications, resolves legacy IDs, and is idempotent', async () => {
    const { sqlite, db, store } = await historicalDatabase({ presentationAgrees: true }); const dry = await runPostingIdentityRepair(db);
    expect(dry).toMatchObject({ eligibleDuplicateGroups: 2, eligibleDuplicateJobs: 2, unresolvedDuplicateGroups: 0 });
    const applied = await runPostingIdentityRepair(db, { apply: true, repairToken: dry.repairToken, expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs });
    expect(applied).toMatchObject({ applied: true, projectionRefreshRequired: true });
    expect(await store.getJob('plus-duplicate')).toMatchObject({ jobId: 'plus-old', open: true, notification: { smsPending: false, digestPending: false, smsSentAt: '2026-07-28T03:13:00.000Z', digestedAt: '2026-07-28T12:00:00.000Z' } });
    expect(await store.pendingSms()).not.toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'plus-old' })]));
    expect(await store.pendingDigest()).not.toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'plus-old' })]));
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT job_id FROM employer_field_proposals WHERE id = 'proposal'").get()).toEqual({ job_id: 'plus-old' });
    const applications = sqlite.prepare("SELECT value FROM user_items WHERE kind = 'application'").all().map((row) => JSON.parse((row as { value: string }).value));
    expect(applications).toEqual([expect.objectContaining({
      applicationId: 'saved',
      jobId: 'plus-old',
      status: 'interview',
      appliedAt: '2026-08-02T12:00:00Z',
      detection: { source: 'gmail', detectedAt: '2026-08-02T12:00:00Z' },
      applyMode: 'official-form',
      notes: 'interview note\n\nlatest note',
    })]);
    const release = JSON.parse((sqlite.prepare("SELECT value FROM user_items WHERE kind = 'catalog-release'").get() as { value: string }).value);
    expect(release).toMatchObject({ jobIds: ['plus-old', 'regular-a'], newJobIds: ['plus-old'] });
    const receipts = sqlite.prepare("SELECT value FROM user_items WHERE kind = 'receipt'").all().map((row) => JSON.parse((row as { value: string }).value));
    expect(receipts).toEqual([expect.objectContaining({ jobId: 'plus-old', status: 'ok', deliveryState: 'delivered' })]);
    const recovery = await store.recoverUndeliveredNotifications({
      since: '2026-08-01T00:00:00.000Z', limit: 10, apply: false,
    });
    expect(recovery).toEqual({ candidates: 1, candidateJobIds: ['drw-old'], requeued: 0 });
    await store.recoverUndeliveredNotifications({
      since: '2026-08-01T00:00:00.000Z', limit: 10, apply: true, expectedCandidateJobIds: ['drw-old'],
    });
    expect(await store.pendingSms()).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'drw-old' })]));
    const verification = await runPostingIdentityRepair(db);
    expect(verification).toMatchObject({ duplicateJobs: 0, expectedChanges: 0, conflicts: [] });
  });

  it('refuses stale guards and existing alias conflicts', async () => {
    const stale = await historicalDatabase({ presentationAgrees: true }); const dry = await runPostingIdentityRepair(stale.db);
    await expect(runPostingIdentityRepair(stale.db, { apply: true, repairToken: dry.repairToken, expectedChanges: dry.expectedChanges + 1, expectedDuplicateJobs: dry.duplicateJobs })).rejects.toThrow('Catalog changed after dry run');
    stale.sqlite.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'CLAIM', 'posting-alias', ?)")
      .run(`POSTING_ALIAS#provider:lever:plus-2:${plusId}`, JSON.stringify({ alias: `provider:lever:plus-2:${plusId}`, canonicalJobId: 'wrong-job' }));
    expect(await runPostingIdentityRepair(stale.db)).toMatchObject({ conflicts: [expect.stringContaining('already claimed')] });
  });
});
