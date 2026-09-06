import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { extractPostingMetadataEvidence, projectRoleMetadata } from '../src/role-metadata.js';
import { persistDestinationAdmission } from '../cloudflare/destination-verification.js';
import { parseMetadataApiResponse } from '../src/metadata-acquisition.js';
import { mergeSourceOccurrence } from '../src/identity/source-occurrence.js';
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
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql']) {
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

function jobWithVerifiedDestination(): Internship {
  const current = job();
  const destination = {
    classification: 'posting-detail' as const,
    candidateUrl: current.applyUrl,
    finalUrl: current.applyUrl,
    provider: 'github' as const,
    inspectedAt: '2026-09-01T00:00:00.000Z',
    browserVisible: true,
  };
  const admission = {
    employerResolution: 'resolved' as const,
    postingAttribution: 'attributed' as const,
    destination,
    metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
    catalogEligible: true,
    alertEligible: true,
    reasonCodes: [],
    evaluatedAt: '2026-09-01T00:00:00.000Z',
    evidenceObservedAt: '2026-09-01T00:00:00.000Z',
  };
  return { ...current, admission, sourceReferences: [{ ...current.sourceReferences[0]!, admission }] };
}

describe('D1 role metadata evidence and guarded repair', () => {
  it.each(['greenhouse', 'lever', 'ashby'] as const)('stages %s API evidence on a GitHub discovery and publishes it only through exact repair guards', async (provider) => {
    const current = subject(); const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const before = await current.jobs.getJob(original.jobId);
    const postingId = provider === 'greenhouse' ? '123' : 'ef725594-42dd-4f0d-ba8e-df8179dbc6cb';
    const identity = { provider, tenant: 'acme', postingId, sourceId: 'community-acme', sourceUrl: original.applyUrl };
    const method = `${provider}-api` as const;
    const payload = provider === 'greenhouse' ? { id: 123, title: original.title,
      content: 'The salary for this role is USD 4500 - 5800 per week.', location: { name: 'New York, NY' } }
      : provider === 'lever' ? { id: postingId, text: original.title, hostedUrl: `https://jobs.lever.co/acme/${postingId}`,
        descriptionPlain: 'Build software.', salaryRange: { currency: 'USD', min: 4500, max: 5800, interval: 'per-week-salary' },
        lists: [{ text: 'Requirements', content: 'Must hold a bachelors degree.' }] }
        : { jobs: [{ id: postingId, title: original.title, jobUrl: `https://jobs.ashbyhq.com/acme/${postingId}`,
          descriptionPlain: 'Build software.', compensation: { scrapeableCompensationSalarySummary: 'Salary USD 4500 - 5800 per week' } }] };
    const artifact = parseMetadataApiResponse(identity, method, payload);
    const observedAt = '2026-09-05T12:00:00.000Z';
    await persistDestinationAdmission({ jobs: current.jobs, operations: current.operations, job: original, reference: original.sourceReferences[0]!,
      message: { version: 1, jobId: original.jobId, sourceId: 'community-acme', externalId: 'row-1', providerIdentity: identity,
        candidateUrl: original.applyUrl, queuedAt: observedAt, reason: 'historical-backfill', metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION, metadataBackfillToken: 'collection-api' },
      reachability: 'live', inspectedAt: observedAt,
      apiAcquisition: { method, sourceUrl: original.applyUrl, outcome: 'acquired', artifact } });
    expect(await current.jobs.getJob(original.jobId)).toEqual(before);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(plan.expectedJobs).toBe(1);
    await current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, observedAt);
    const repaired = await current.jobs.getJob(original.jobId);
    expect(repaired?.compensation.ranges).toMatchObject([{ minAmount: 4500, maxAmount: 5800, period: 'weekly', currency: 'USD' }]);
    expect(repaired?.notification).toEqual(original.notification);
    expect(repaired?.sourceReferences[0]?.admission).toEqual(original.sourceReferences[0]?.admission);
    expect(repaired?.applyUrl).toBe(original.applyUrl);
    expect(repaired?.compensation.minAnnualUSD).toBeUndefined();
    const laterList = extractPostingMetadataEvidence({ artifact: { title: original.title, text: 'No salary field in the board list.' },
      sourceClass: 'official-ats', sourceId: 'community-acme', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
      observedAt: '2026-09-05T12:05:00.000Z', exactPosting: true });
    const merged = mergeSourceOccurrence(repaired!.sourceReferences[0], { ...original.sourceReferences[0]!, metadataEvidence: laterList });
    expect(projectRoleMetadata({ ...repaired!, sourceReferences: [merged] }).job.compensation.ranges)
      .toMatchObject([{ minAmount: 4500, maxAmount: 5800, period: 'weekly' }]);
  });
  it('reserves disjoint resumable batches, revisits old versions and expires abandoned leases', async () => {
    const current = subject();
    for (const id of ['a', 'b', 'c']) await current.jobs.putInternship({ ...jobWithVerifiedDestination(), jobId: id });
    await current.operations.recordRoleMetadataExtraction({ jobId: 'a', sourceId: 'community-acme', sourceUrl: job().applyUrl,
      artifactHash: 'old', extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, outcome: 'no-explicit-metadata', observedAt: '2026-09-05T00:00:00.000Z' });
    const options = { observedBefore: '2026-09-01T00:00:00.000Z', reserveAt: '2026-09-05T01:00:00.000Z', after: '' };
    const first = await current.operations.metadataVerificationCandidates(1, options);
    expect(first.map((row) => row.jobId)).toEqual(['a']);
    expect((await current.operations.metadataVerificationCandidates(1, options)).map((row) => row.jobId)).toEqual(['b']);
    expect((await current.operations.metadataVerificationCandidates(1, { ...options, after: 'b\0community-acme' })).map((row) => row.jobId)).toEqual(['c']);
    expect(await current.operations.metadataVerificationCandidates(1, options)).toEqual([]);
    expect((await current.operations.metadataVerificationCandidates(1, { ...options, reserveAt: '2026-09-05T01:31:00.000Z' })).map((row) => row.jobId)).toEqual(['a']);
  });

  it('collects withheld open roles and ignores only superseded-version retry backoff', async () => {
    const current = subject(); const original = jobWithVerifiedDestination();
    const withheld = { ...original, admission: { ...original.admission!, catalogEligible: false, alertEligible: false } };
    await current.jobs.putInternship(withheld);
    await current.jobs.putInternship({ ...original, jobId: 'closed', open: false });
    await current.operations.recordMetadataAcquisition(original.jobId, 'community-acme', '2026-09-05T00:00:00.000Z',
      { extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, complete: true }, '2026-10-05T00:00:00.000Z');
    expect((await current.operations.roleMetadataAudit()).collectionCoverage.eligible).toBe(1);
    expect((await current.operations.metadataVerificationCandidates(10, { reserveAt: '2026-09-06T00:00:00.000Z' })).map(row => row.jobId)).toEqual([original.jobId]);
    expect(await current.operations.metadataVerificationCandidates(10, { reserveAt: '2026-09-06T00:01:00.000Z' })).toEqual([]);
    expect((await current.jobs.getJob(original.jobId))?.admission?.catalogEligible).toBe(false);
  });

  it('collects a confirmed legacy Workday occurrence without inventing admission', async () => {
    const current = subject(); const original = job();
    original.applyUrl = 'https://acme.wd1.myworkdayjobs.com/External/job/New-York/Intern_R123';
    original.sourceReferences[0] = { ...original.sourceReferences[0]!, applyUrl: original.applyUrl,
      postingIdentityDecision: { status: 'confirmed', exactKey: 'provider:workday:acme:r123', provider: 'workday', tenant: 'acme',
        evidenceKind: 'immutable-provider-id', contractId: 'posting-provider-workday', contractVersion: 1,
        approvalReference: 'registry:workday:v1', evidenceHash: 'confirmed-hash', observedAt: '2026-09-05T00:00:00.000Z' } };
    await current.jobs.putInternship(original);
    expect((await current.operations.roleMetadataAudit()).collectionCoverage.eligible).toBe(1);
    expect(await current.operations.metadataVerificationCandidates(10)).toMatchObject([
      { jobId: original.jobId, providerIdentity: { provider: 'workday', tenant: 'acme', postingId: 'r123' } },
    ]);
    expect((await current.jobs.getJob(original.jobId))?.admission).toBeUndefined();
    original.sourceReferences[0] = { ...original.sourceReferences[0]!, applyUrl: original.applyUrl.replace('R123', 'R999') };
    await current.jobs.putInternship(original);
    expect(await current.operations.metadataVerificationCandidates(10)).toEqual([]);
    expect((await current.operations.roleMetadataAudit()).collectionCoverage.eligible).toBe(0);
  });

  it('backs off failed acquisitions without calling them complete or starving other jobs', async () => {
    const current = subject();
    for (const id of ['a', 'b']) await current.jobs.putInternship({ ...jobWithVerifiedDestination(), jobId: id });
    await current.operations.recordMetadataAcquisition('a', 'community-acme', '2026-09-05T00:00:00.000Z',
      { fields: { compensation: 'acquisition-failed' }, complete: false, method: 'browser' }, '2026-09-06T00:00:00.000Z');
    expect((await current.operations.metadataVerificationCandidates(5, { reserveAt: '2026-09-05T01:00:00.000Z' })).map((row) => row.jobId)).toEqual(['b']);
    const audit = await current.operations.roleMetadataAudit(new Date('2026-09-05T01:00:00.000Z'));
    expect(audit.collectionCoverage.complete).toBe(false);
    expect(audit.disclosureRecall).toBeNull();
    expect(audit.fieldOutcomes['github/browser/compensation']).toEqual({ 'acquisition-failed': 1 });
  });
  it('reports and blocks incomplete exact-destination collection', async () => {
    const current = subject();
    const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const firstAudit = await current.operations.roleMetadataAudit(new Date('2026-09-04T12:00:00.000Z'));
    expect(firstAudit.collectionCoverage).toMatchObject({
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, eligible: 1, current: 0, pendingOrUnobserved: 1, stale: 0, complete: false,
    });
    const incompletePlan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:00:00.000Z');
    await expect(current.operations.applyRoleMetadataRepair(
      incompletePlan.repairToken,
      incompletePlan.expectedJobs,
      incompletePlan.expectedOccurrences,
      '2026-09-04T12:01:00.000Z',
    )).rejects.toThrow('collection was incomplete during the dry-run');

    await current.operations.recordRoleMetadataExtraction({
      jobId: original.jobId,
      sourceId: original.sourceReferences[0]!.sourceId,
      sourceUrl: original.applyUrl,
      artifactHash: 'no-explicit-metadata',
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      outcome: 'no-explicit-metadata',
      observedAt: '2026-07-01T12:02:00.000Z',
      backfillToken: 'collection-1',
    });
    const staleAudit = await current.operations.roleMetadataAudit(new Date('2026-09-04T12:03:00.000Z'));
    expect(staleAudit.collectionCoverage).toMatchObject({
      eligible: 1, current: 0, pendingOrUnobserved: 0, stale: 1, complete: false,
    });
    const stalePlan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:03:00.000Z');
    await expect(current.operations.applyRoleMetadataRepair(
      stalePlan.repairToken,
      stalePlan.expectedJobs,
      stalePlan.expectedOccurrences,
      '2026-09-04T12:04:00.000Z',
    )).rejects.toThrow('collection was incomplete during the dry-run');

    await current.operations.recordRoleMetadataExtraction({
      jobId: original.jobId,
      sourceId: original.sourceReferences[0]!.sourceId,
      sourceUrl: original.applyUrl,
      artifactHash: 'no-explicit-metadata',
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      outcome: 'no-explicit-metadata',
      observedAt: '2026-09-04T12:05:00.000Z',
      backfillToken: 'collection-1',
    });
    const completeAudit = await current.operations.roleMetadataAudit(new Date('2026-09-04T12:06:00.000Z'));
    expect(completeAudit.collectionCoverage).toMatchObject({
      eligible: 1, current: 1, pendingOrUnobserved: 0, stale: 0, complete: true,
      outcomes: { 'no-explicit-metadata': 1 }, backfillTokens: { 'collection-1': 1 },
    });
    const completePlan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:06:00.000Z');
    await expect(current.operations.applyRoleMetadataRepair(
      completePlan.repairToken,
      completePlan.expectedJobs,
      completePlan.expectedOccurrences,
      '2026-09-04T12:07:00.000Z',
    )).resolves.toMatchObject({ changed: 0, occurrencesChanged: 0, projectionRefreshRequired: false });
  });

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
