import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { CatalogAdmission, Internship } from '../src/types.js';

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return database.prepare(query).get(...values) as T | null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function admission(catalogEligible: boolean): CatalogAdmission {
  return {
    canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved', postingAttribution: 'attributed',
    destination: { classification: catalogEligible ? 'posting-detail' : 'aggregate-board', candidateUrl: 'https://careers.acme.test/role-1',
      provider: 'structured', inspectedAt: '2026-08-26T12:00:00Z' },
    metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible, alertEligible: catalogEligible,
    reasonCodes: catalogEligible ? [] : ['destination-aggregate-board'], evaluatedAt: '2026-08-26T12:00:00Z', evidenceObservedAt: '2026-08-26T12:00:00Z',
  };
}

function job(): Internship {
  return {
    jobId: 'job-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: 'https://careers.acme.test/role-1', normalizedUrl: 'https://careers.acme.test/role-1', fingerprint: 'fingerprint',
    compensation: { raw: '' }, sourceReferences: [], technical: true, open: true,
    firstSeenAt: '2026-08-01T00:00:00Z', catalogVisibleAt: '2026-08-01T00:00:00Z', catalogRecency: 'normal',
    lastSeenAt: '2026-08-26T00:00:00Z', notification: { smsPending: false, smsSentAt: '2026-08-02T00:00:00Z', digestPending: false },
    admission: admission(false),
  };
}

function subject() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, db, admission: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

describe('D1 catalog admission operations', () => {
  it('requires explicit mapping supersession', async () => {
    const { admission: store } = subject();
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    await store.putCanonicalEmployer({ id: 'new-acme', displayName: 'New Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    await store.supersedeEmployerMapping({ id: 'first', provider: 'greenhouse', scope: 'axon', canonicalEmployerId: 'acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.supersedeEmployerMapping({ id: 'bad', provider: 'greenhouse', scope: 'axon', canonicalEmployerId: 'new-acme', reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' })).rejects.toThrow('explicitly superseded');
    await store.supersedeEmployerMapping({ id: 'second', provider: 'greenhouse', scope: 'axon', canonicalEmployerId: 'new-acme', reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer', supersedesMappingId: 'first' });
    expect(await store.listEmployerMappings()).toMatchObject([
      { id: 'first', supersededAt: '2026-08-27T00:00:00Z' }, { id: 'second', supersedesMappingId: 'first' },
    ]);
  });

  it('applies an exact staged repair silently and rolls back on a changed source row', async () => {
    const { database, admission: store, jobs } = subject();
    await jobs.putInternship(job());
    const preview = await store.stageRepair([{ jobId: 'job-1', admission: admission(true), company: 'Acme, Inc.' }], '2026-08-26T12:00:00Z');
    const before = await jobs.getJob('job-1');
    const result = await store.applyRepair(preview.repairToken, preview.changed, '2026-08-26T12:05:00Z');
    const after = await jobs.getJob('job-1');
    expect(result).toEqual({ changed: 1, projectionRefreshRequired: true });
    expect(after).toMatchObject({ jobId: before?.jobId, company: 'Acme, Inc.', firstSeenAt: before?.firstSeenAt,
      catalogVisibleAt: before?.catalogVisibleAt, notification: before?.notification, admission: { catalogEligible: true } });
    expect((await jobs.listOpen()).jobs).toHaveLength(1);
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 0 });

    const stale = await store.stageRepair([{ jobId: 'job-1', admission: admission(false) }], '2026-08-26T13:00:00Z');
    await jobs.putInternship({ ...after!, title: 'Source changed this row' });
    await expect(store.applyRepair(stale.repairToken, stale.changed, '2026-08-26T13:05:00Z')).rejects.toThrow();
    expect((await jobs.getJob('job-1'))?.title).toBe('Source changed this row');
    expect((await jobs.getJob('job-1'))?.admission?.catalogEligible).toBe(true);
  });
});
