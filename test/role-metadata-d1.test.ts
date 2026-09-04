import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { extractPostingMetadataEvidence, projectRoleMetadata } from '../src/role-metadata.js';
import type { Internship } from '../src/types.js';

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

function subject() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, operations: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

function job(): Internship {
  return {
    jobId: 'job-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'],
    season: 'summer-2027', applyUrl: 'https://careers.acme.test/jobs/123', normalizedUrl: 'https://careers.acme.test/jobs/123',
    fingerprint: 'fingerprint', compensation: { raw: '' }, sourceReferences: [{ sourceId: 'community-acme', externalId: 'row-1',
      document: 'README.md', sourceUrl: 'https://github.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: 'https://careers.acme.test/jobs/123',
      compensation: { raw: '' }, state: 'open' }], technical: true, open: true, firstSeenAt: '2026-08-01T00:00:00.000Z',
    catalogVisibleAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-09-04T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false, smsSentAt: '2026-08-01T00:01:00.000Z' },
  };
}

describe('D1 role metadata evidence and guarded repair', () => {
  it('retains artifact history and silently applies an exact staged projection', async () => {
    const current = subject();
    const original = job();
    await current.jobs.putInternship(original);
    current.database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('OUTBOX#old', 'EVENT', 'notification-event', '{}')").run();
    const superseded = extractPostingMetadataEvidence({
      artifact: { title: original.title, compensationText: 'USD $40/hour', locations: ['New York, NY'] },
      sourceClass: 'official-page', sourceId: 'community-acme', sourceUrl: original.applyUrl,
      observedAt: '2026-09-03T12:00:00.000Z', exactPosting: true,
    });
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: original.title, text: 'Location: New York, NY. Pay is $45-$55/hour. This role is hybrid.',
        compensationText: '$45-$55/hour', locations: ['New York, NY'], workMode: 'Hybrid' },
      sourceClass: 'official-page', sourceId: 'community-acme', sourceUrl: original.applyUrl,
      observedAt: '2026-09-04T12:00:00.000Z', exactPosting: true,
    });
    const projected = projectRoleMetadata({ ...original, sourceReferences: [{ ...original.sourceReferences[0]!, metadataEvidence: evidence }] });
    await current.operations.recordRoleMetadataEvidence(original.jobId, superseded, [], '2026-09-03T12:00:00.000Z');
    await current.operations.recordRoleMetadataEvidence(original.jobId, evidence, projected.conflicts, '2026-09-04T12:00:00.000Z');
    expect(current.database.prepare('SELECT count(*) AS total, sum(is_current) AS current FROM role_metadata_evidence').get())
      .toEqual({ total: 2, current: 1 });
    const plan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:01:00.000Z');
    expect(plan).toMatchObject({ expectedJobs: 1, expectedOccurrences: 0, conflicts: [], fillsByField: { compensation: 1, workMode: 1 } });
    const result = await current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, plan.expectedOccurrences, '2026-09-04T12:02:00.000Z');
    expect(result).toEqual({ changed: 1, occurrencesChanged: 0, projectionRefreshRequired: true });
    expect(await current.jobs.getJob(original.jobId)).toMatchObject({
      jobId: original.jobId, compensation: { minHourlyUSD: 45, maxHourlyUSD: 55 }, workMode: 'hybrid',
      notification: original.notification, firstSeenAt: original.firstSeenAt,
    });
    expect(current.database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 1 });
    expect((await current.operations.roleMetadataAudit()).projectionOnlyOmissions).toEqual([]);
  });

  it('rejects a stale original JSON guard', async () => {
    const current = subject();
    await current.jobs.putInternship(job());
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: 'USD $45/hour' }, sourceClass: 'official-page', sourceId: 'community-acme',
      sourceUrl: job().applyUrl, observedAt: '2026-09-04T12:00:00.000Z', exactPosting: true,
    });
    await current.operations.recordRoleMetadataEvidence('job-1', evidence, [], '2026-09-04T12:00:00.000Z');
    const plan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:01:00.000Z');
    await current.jobs.putInternship({ ...job(), lastSeenAt: '2026-09-04T12:01:30.000Z' });
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, '2026-09-04T12:02:00.000Z')).rejects.toThrow();
    expect((await current.jobs.getJob('job-1'))?.compensation.raw).toBe('');
  });

  it('binds combined historical conflicts to the dry-run token', async () => {
    const current = subject();
    const conflictJob = { ...job(), sourceReferences: [
      { ...job().sourceReferences[0]!, sourceId: 'source-one', externalId: 'one' },
      { ...job().sourceReferences[0]!, sourceId: 'source-two', externalId: 'two' },
    ] };
    const safeJob = { ...job(), jobId: 'job-2', normalizedUrl: 'https://careers.acme.test/jobs/456',
      applyUrl: 'https://careers.acme.test/jobs/456', fingerprint: 'fingerprint-2', sourceReferences: [
        { ...job().sourceReferences[0]!, sourceId: 'source-safe', externalId: 'safe' },
      ] };
    await current.jobs.putInternship(conflictJob);
    await current.jobs.putInternship(safeJob);
    const pay = (sourceId: string, amount: number) => extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: `USD $${amount}/hour` }, sourceClass: 'official-page', sourceId,
      sourceUrl: `https://${sourceId}.example.test/jobs/123`, observedAt: '2026-09-04T12:00:00.000Z', exactPosting: true,
    });
    await current.operations.recordRoleMetadataEvidence('job-1', pay('source-one', 40), [], '2026-09-04T12:00:00.000Z');
    await current.operations.recordRoleMetadataEvidence('job-1', pay('source-two', 50), [], '2026-09-04T12:00:00.000Z');
    await current.operations.recordRoleMetadataEvidence('job-2', pay('source-safe', 60), [], '2026-09-04T12:00:00.000Z');
    const plan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:01:00.000Z');
    expect(plan).toMatchObject({ expectedJobs: 1, conflicts: [{ field: 'compensation' }] });
    expect(current.database.prepare("SELECT count(*) AS count FROM role_metadata_conflicts WHERE state = 'open'").get()).toEqual({ count: 0 });
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, plan.expectedOccurrences,
      '2026-09-04T12:02:00.000Z')).rejects.toThrow('conflicts must be resolved');
    expect((await current.jobs.getJob('job-2'))?.compensation.raw).toBe('');
  });

  it('requeues projected exact-page evidence after the revalidation cutoff', async () => {
    const current = subject();
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: 'USD $45/hour' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: job().applyUrl, observedAt: '2026-07-01T12:00:00.000Z', exactPosting: true,
    });
    const destination = {
      classification: 'posting-detail' as const, candidateUrl: job().applyUrl, finalUrl: job().applyUrl,
      provider: 'github' as const, inspectedAt: '2026-07-01T12:00:00.000Z', browserVisible: true,
    };
    const admission = {
      employerResolution: 'resolved' as const, postingAttribution: 'attributed' as const, destination,
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: '2026-07-01T12:00:00.000Z',
      evidenceObservedAt: '2026-07-01T12:00:00.000Z',
    };
    const currentJob = job();
    currentJob.sourceReferences = [{ ...currentJob.sourceReferences[0]!, metadataEvidence: evidence, admission }];
    currentJob.admission = admission;
    await current.jobs.putInternship(currentJob);
    await current.operations.recordRoleMetadataEvidence(currentJob.jobId, evidence, [], '2026-07-01T12:00:00.000Z');
    await expect(current.operations.metadataVerificationCandidates(10, {
      observedBefore: '2026-08-01T00:00:00.000Z', includeUnobserved: false, requireProjectedEvidence: true,
    })).resolves.toMatchObject([{ jobId: 'job-1', sourceId: 'community-acme', metadataArtifactHash: evidence[0]!.artifactHash }]);
    await expect(current.operations.metadataVerificationCandidates(10, {
      observedBefore: '2026-06-01T00:00:00.000Z', includeUnobserved: false, requireProjectedEvidence: true,
    })).resolves.toEqual([]);
  });
});
