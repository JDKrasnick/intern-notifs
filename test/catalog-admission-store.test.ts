import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { persistDestinationAdmission, reachabilityFromHttpStatus, type DestinationVerificationMessage } from '../cloudflare/destination-verification.js';
import { matchingBrowserDestination } from '../src/destination-verification.js';
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
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0008_catalog_admission_occurrence_repair.sql',
    '0010_posting_identity.sql',
    '0011_destination_verification_schedule.sql']) {
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
    await expect(store.resolveCanonicalEmployer({ provider: 'greenhouse', sourceId: 'greenhouse-axon', tenant: 'axon', postingId: 'role-1', sourceUrl: 'https://example.test' }))
      .resolves.toEqual({ id: 'new-acme', displayName: 'New Acme' });
  });

  it('maps community rows by employer scope instead of the multi-employer source', async () => {
    const { admission: store } = subject();
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    await store.supersedeEmployerMapping({ id: 'unsafe-source', provider: 'github', scope: 'community-list', canonicalEmployerId: 'acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveCanonicalEmployer({ provider: 'github', sourceId: 'community-list', employerScope: 'employer:other', sourceUrl: 'https://github.com/example/jobs' }))
      .resolves.toBeUndefined();
    await store.supersedeEmployerMapping({ id: 'acme-row', provider: 'github', scope: 'employer:acme', canonicalEmployerId: 'acme', reviewedAt: '2026-08-26T01:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveCanonicalEmployer({ provider: 'github', sourceId: 'community-list', employerScope: 'employer:acme', sourceUrl: 'https://github.com/example/jobs' }))
      .resolves.toEqual({ id: 'acme', displayName: 'Acme' });
  });

  it('versions reviewed admission configuration deterministically', async () => {
    const { admission: store } = subject();
    const empty = await store.configurationVersion();
    expect(await store.configurationVersion()).toBe(empty);
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    const populated = await store.configurationVersion();
    expect(populated).not.toBe(empty);
    expect(await store.configurationVersion()).toBe(populated);
  });

  it('audits review records by source, destination, and prior notification history', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    current.sourceReferences = [{
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: current.company, title: current.title,
      location: current.location, locations: [current.location], season: current.season, applyUrl: current.applyUrl,
      compensation: current.compensation, state: 'open', admission: current.admission,
    }];
    await jobs.putInternship(current);

    await expect(store.audit()).resolves.toMatchObject({
      scanned: 1,
      review: 1,
      legacyUnclassified: 0,
      bySource: { 'community-list': 1 },
      byDestination: { 'aggregate-board': 1 },
      withNotificationHistory: 1,
      records: [{ jobId: current.jobId, sourceIds: ['community-list'], destinationClassification: 'aggregate-board', smsSent: true }],
    });
  });

  it('queues every unclassified occurrence with provider identity for historical verification', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    delete current.admission;
    current.sourceReferences = [{
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, locations: [current.location], season: current.season,
      applyUrl: 'https://careers.acme.test/openings?gh_jid=7654321', compensation: current.compensation, state: 'open',
      employerLabelOrigin: 'explicit',
    }];
    await jobs.putInternship(current);

    await expect(store.legacyVerificationCandidates()).resolves.toEqual([{
      jobId: current.jobId, sourceId: 'community-list', externalId: 'row-1',
      candidateUrl: 'https://careers.acme.test/openings?gh_jid=7654321',
      providerIdentity: { provider: 'greenhouse', sourceId: 'community-list', sourceUrl: 'https://github.com/example/jobs',
        employerScope: 'employer:acme', postingId: '7654321' },
      occurrenceSnapshotHash: expect.any(String),
    }]);
  });

  it('never reconstructs an employer scope for cross-tenant inherited community rows', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    delete current.admission;
    const reference = {
      sourceId: 'community-list', provenance: 'reviewed-community' as const, externalId: 'row-2', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 2, company: 'Acme', title: current.title,
      location: current.location, season: current.season,
      applyUrl: 'https://other.wd1.myworkdayjobs.com/en-US/jobs/job/Security_R-102', compensation: current.compensation,
      state: 'open' as const, employerLabelOrigin: 'inherited' as const, employerInheritance: 'conflict' as const,
    };
    current.sourceReferences = [reference];
    await jobs.putInternship(current);
    const [candidate] = await store.legacyVerificationCandidates();
    expect(candidate?.providerIdentity).toMatchObject({ provider: 'workday', tenant: 'other', postingId: 'r-102' });
    expect(candidate?.providerIdentity).not.toHaveProperty('employerScope');

    const admitted = admission(true);
    admitted.destination = { ...admitted.destination, provider: 'workday', tenant: 'other', expectedPostingId: 'r-102',
      nextCheckAt: '2026-08-30T00:00:00Z' };
    await jobs.putInternship({ ...current, admission: admitted, sourceReferences: [{ ...reference, admission: admitted }] });
    await store.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const [scheduled] = await store.leaseDueVerifications('2026-08-30T00:00:00Z');
    expect(scheduled?.providerIdentity).not.toHaveProperty('employerScope');
  });

  it('freezes resumable backfill generations and stores historical evidence without changing catalog JSON', async () => {
    const { database, admission: store, jobs } = subject();
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-30T00:00:00Z',
      reviewedBy: 'reviewer' }, '2026-08-30T00:00:00Z');
    await store.supersedeEmployerMapping({ id: 'greenhouse-acme', provider: 'greenhouse', scope: 'greenhouse-acme',
      canonicalEmployerId: 'acme', reviewedAt: '2026-08-30T00:00:00Z', reviewedBy: 'reviewer' });
    const current = job();
    delete current.admission;
    current.sourceReferences = [{ sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '7654321', document: '7654321',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, locations: [current.location], season: current.season,
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', compensation: current.compensation, state: 'open' }];
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: 'greenhouse-acme', externalId: '7654321', jobId: current.jobId,
      occurrence: current.sourceReferences[0]!, present: true, consecutiveOmissions: 0,
      changedSnapshotHash: 'snapshot', changedAt: '2026-08-29T00:00:00Z' });
    const before = await jobs.getJob(current.jobId);
    const generation = await store.previewBackfill('2026-08-30T00:00:00Z');
    expect(generation).toMatchObject({ state: 'previewed', total: 1, queued: 0, completed: 0 });
    const page = await store.backfillPage(generation.id, 0, 100);
    expect(page).toMatchObject([{ jobId: current.jobId, sourceId: 'greenhouse-acme', externalId: '7654321' }]);
    await store.markBackfillQueued(generation.id, [page[0]!.occurrenceKey], '2026-08-30T00:01:00Z');
    await store.recordBackfillEvidence({ generationId: generation.id, occurrenceKey: page[0]!.occurrenceKey,
      evidenceHash: 'candidate-hash', classification: 'posting-detail', value: {
        classification: 'posting-detail', candidateUrl: current.applyUrl, provider: 'greenhouse', tenant: 'acme',
        expectedPostingId: '7654321', inspectedAt: '2026-08-30T00:02:00Z', freshUntil: '2026-09-06T00:02:00Z',
      }, observedAt: '2026-08-30T00:02:00Z' });
    await store.recordBackfillEvidence({ generationId: generation.id, occurrenceKey: page[0]!.occurrenceKey,
      evidenceHash: 'redelivery-hash', classification: 'gone', value: { classification: 'gone' },
      observedAt: '2026-08-30T00:02:30Z' });
    expect(database.prepare(`SELECT evidence_hash, classification FROM admission_backfill_evidence
      WHERE generation_id = ? AND occurrence_key = ?`).get(generation.id, page[0]!.occurrenceKey))
      .toEqual({ evidence_hash: 'candidate-hash', classification: 'posting-detail' });
    expect(await store.backfillProgress(generation.id)).toMatchObject({ state: 'complete', queued: 1, completed: 1 });
    expect(await jobs.getJob(current.jobId)).toEqual(before);
    await jobs.putInternship({ ...current,
      sourceReferences: [{ ...current.sourceReferences[0]!, title: 'Completely Different Security Role' }] });
    await expect(store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme')).rejects.toThrow('drifted');
    await jobs.putInternship({ ...current, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/9999999',
      sourceReferences: [{ ...current.sourceReferences[0]!, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/9999999' }] });
    await expect(store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme')).rejects.toThrow('drifted');
    await jobs.putInternship(before!);
    const derived = await store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme');
    expect(derived).toMatchObject({ records: 2, changes: [{ jobId: current.jobId,
      admission: { catalogEligible: true, alertEligible: true } }] });
    const staged = await store.stageRepair(derived.changes, '2026-08-30T00:03:00Z');
    await store.applyRepair(staged.repairToken, staged.changed, '2026-08-30T00:04:00Z', staged.occurrencesChanged);
    expect(await jobs.getJob(current.jobId)).toMatchObject({ applicationUrlValidatedAt: '2026-08-30T00:02:00Z',
      admission: { catalogEligible: true },
      sourceReferences: [{ admission: { catalogEligible: true } }] });
    const zero = await store.stageRepair((await store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme')).changes,
      '2026-08-30T00:05:00Z');
    expect(zero).toMatchObject({ changed: 0, occurrencesChanged: 0 });
  });

  it('leases due occurrence checks once and resumes after the lease expires', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    current.admission = admission(true);
    current.admission.destination.nextCheckAt = '2026-08-30T00:00:00Z';
    current.sourceReferences = [{ sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, season: current.season, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321',
      compensation: current.compensation, state: 'open', admission: current.admission }];
    await jobs.putInternship(current);
    await store.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const first = await store.leaseDueVerifications('2026-08-30T00:00:00Z');
    expect(first).toHaveLength(1);
    await expect(store.leaseDueVerifications('2026-08-30T00:01:00Z')).resolves.toEqual([]);
    const resumed = await store.leaseDueVerifications('2026-08-30T00:16:00Z');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.occurrenceKey).toBe(first[0]!.occurrenceKey);
  });

  it('releases a stale lease immediately when the occurrence destination generation changes', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    const firstUrl = 'https://job-boards.greenhouse.io/acme/jobs/7654321';
    const secondUrl = 'https://job-boards.greenhouse.io/acme/jobs/8765432';
    current.admission = admission(true);
    current.admission.destination = { ...current.admission.destination, candidateUrl: firstUrl,
      provider: 'greenhouse', tenant: 'acme', expectedPostingId: '7654321', nextCheckAt: '2026-08-30T00:00:00Z' };
    const reference = { sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, season: current.season, applyUrl: firstUrl,
      compensation: current.compensation, state: 'open' as const, admission: current.admission };
    current.sourceReferences = [reference];
    await jobs.putInternship(current);
    await store.syncVerificationSchedule('2026-08-30T00:00:00Z');
    expect(await store.leaseDueVerifications('2026-08-30T00:00:00Z')).toHaveLength(1);

    await jobs.putInternship({ ...current, applyUrl: secondUrl, normalizedUrl: secondUrl,
      sourceReferences: [{ ...reference, applyUrl: secondUrl }] });
    await store.syncVerificationSchedule('2026-08-30T00:01:00Z');
    const [replacement] = await store.leaseDueVerifications('2026-08-30T00:01:00Z');
    expect(replacement).toMatchObject({ candidateUrl: secondUrl,
      providerIdentity: { provider: 'greenhouse', tenant: 'acme', postingId: '8765432' } });
  });

  it('atomically rejects an admission write after its exact occurrence generation drifts', async () => {
    const { jobs } = subject();
    const current = job();
    const expectedReference = { sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: '7654321',
      document: '7654321', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1,
      company: 'Acme', title: current.title, location: current.location, season: current.season,
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', compensation: current.compensation, state: 'open' as const };
    const expected = { ...current, sourceReferences: [expectedReference] };
    await jobs.putInternship(expected);
    const changedReference = { ...expectedReference, title: 'Security Engineering Intern',
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/8765432' };
    await jobs.putInternship({ ...expected, title: changedReference.title, applyUrl: changedReference.applyUrl,
      normalizedUrl: changedReference.applyUrl, sourceReferences: [changedReference] });

    const proposedAdmission = admission(true);
    const persisted = await jobs.putAdmissionState({ ...expected, admission: proposedAdmission,
      sourceReferences: [{ ...expectedReference, admission: proposedAdmission }] }, expectedReference);
    expect(persisted).toBe(false);
    expect(await jobs.getJob(current.jobId)).toMatchObject({ title: changedReference.title, applyUrl: changedReference.applyUrl,
      sourceReferences: [{ title: changedReference.title, applyUrl: changedReference.applyUrl }] });
  });

  it('resolves tenant-specific review rules ahead of host-wide rules', async () => {
    const { admission: store } = subject();
    await store.putReviewRule({ id: 'host', host: 'careers.acme.test', provider: 'greenhouse', decision: 'browser-required',
      reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' });
    await store.putReviewRule({ id: 'tenant', host: 'careers.acme.test', provider: 'greenhouse', tenant: 'acme', decision: 'blocked-accepted',
      reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveReviewRule({ provider: 'greenhouse', sourceId: 'greenhouse-acme', tenant: 'acme', postingId: 'role-1', sourceUrl: 'https://example.test' },
      'https://careers.acme.test/role-1')).resolves.toMatchObject({ id: 'tenant', decision: 'blocked-accepted' });
    await expect(store.resolveReviewRule({ provider: 'greenhouse', sourceId: 'greenhouse-other', tenant: 'other', postingId: 'role-1', sourceUrl: 'https://example.test' },
      'https://careers.acme.test/role-1')).resolves.toMatchObject({ id: 'host', decision: 'browser-required' });
    await store.putReviewRule({ id: 'host-replacement', host: 'careers.acme.test', provider: 'greenhouse', decision: 'aggregate-board',
      reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveReviewRule({ provider: 'greenhouse', sourceId: 'greenhouse-other', tenant: 'other', postingId: 'role-1', sourceUrl: 'https://example.test' },
      'https://careers.acme.test/role-1')).resolves.toMatchObject({ id: 'host-replacement', decision: 'aggregate-board' });
    expect((await store.listReviewRules()).filter((rule) => !rule.tenant)).toHaveLength(1);
  });

  it('resolves stale incidents while retaining the current reason', async () => {
    const { admission: store } = subject();
    const base = { jobId: 'job-1', sourceId: 'greenhouse-acme', host: 'careers.acme.test', state: 'open' as const,
      openedAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' };
    await store.upsertIncident({ ...base, id: 'old', reasonCode: 'destination-unresolved' });
    await store.upsertIncident({ ...base, id: 'current', reasonCode: 'destination-grace' });
    await store.upsertIncident({ ...base, id: 'quarantine', reasonCode: 'destination-gone', state: 'quarantined' });
    await store.resolveIncidents('job-1', 'greenhouse-acme', '2026-08-27T00:00:00Z', 'destination-grace');
    expect(await store.listActiveIncidents()).toMatchObject([{ id: 'current', reasonCode: 'destination-grace' }]);
    await store.resolveIncidents('job-1', 'greenhouse-acme', '2026-08-27T01:00:00Z');
    expect(await store.listActiveIncidents()).toEqual([]);
  });

  it('expires grace after a failed browser retry and clears the incident after recovery', async () => {
    const { admission: operations, jobs } = subject();
    const previous = admission(true);
    previous.destination = { ...previous.destination, classification: 'unresolved', finalUrl: 'https://careers.acme.test/role-1',
      lastKnownGoodAt: '2026-08-20T00:00:00Z' };
    previous.alertEligible = false;
    previous.reasonCodes = ['destination-grace'];
    previous.graceDeadline = '2026-08-27T00:00:00Z';
    const reference = {
      sourceId: 'structured-acme', provenance: 'official-structured' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://careers.acme.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: 'https://careers.acme.test/role-1',
      compensation: { raw: '' }, state: 'open' as const, admission: previous,
    };
    const current = { ...job(), sourceReferences: [reference], admission: previous };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot-1', changedAt: '2026-08-20T00:00:00Z',
      firstObservedAt: '2026-08-20T00:00:00Z', firstObservedAtPrecision: 'exact' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'structured', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, tenant: 'careers.acme.test', postingId: reference.externalId },
      candidateUrl: reference.applyUrl, reason: 'daily-retry', queuedAt: '2026-08-28T00:00:00Z' };

    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'unreachable', inspectedAt: '2026-08-28T00:00:00Z' });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ admission: { catalogEligible: false, alertEligible: false,
      reasonCodes: ['destination-unresolved'] } });
    expect(await operations.listActiveIncidents()).toMatchObject([{ reasonCode: 'destination-unresolved', state: 'open' }]);

    const expired = (await jobs.getJob(current.jobId))!;
    const expiredReference = expired.sourceReferences[0]!;
    await persistDestinationAdmission({ jobs, operations, message, job: expired, reference: expiredReference, reachability: 'live',
      inspectedAt: '2026-08-28T01:00:00Z', browserVisible: true,
      evidence: { url: reference.applyUrl, title: reference.title, postingIdPresent: true, jobPostingCount: 1,
        confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] } } });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ admission: { catalogEligible: true, alertEligible: true, reasonCodes: [] } });
    expect(await operations.listActiveIncidents()).toEqual([]);
  });

  it('turns authoritative destination closure into a reversible canonical close without closing the occurrence', async () => {
    const { admission: operations, jobs } = subject();
    const good = admission(true);
    const reference = { sourceId: 'structured-acme', provenance: 'official-structured' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://careers.acme.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote',
      season: 'summer-2027', applyUrl: 'https://careers.acme.test/role-1', compensation: { raw: '' }, state: 'open' as const, admission: good };
    const current = { ...job(), open: true, admission: good, applicationUrlValidatedAt: '2026-08-29T00:00:00Z',
      notification: { smsPending: true, digestPending: true }, sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot', changedAt: '2026-08-29T00:00:00Z' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'structured', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, tenant: 'careers.acme.test', postingId: reference.externalId },
      candidateUrl: reference.applyUrl, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z' };
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'gone',
      inspectedAt: '2026-08-30T00:00:00Z' });
    const closed = (await jobs.getJob(current.jobId))!;
    expect(closed).toMatchObject({ open: false, invalidApplicationUrl: reference.applyUrl,
      notification: { smsPending: false, digestPending: false }, admission: { reasonCodes: ['destination-gone'] },
      sourceReferences: [{ state: 'open' }] });
    expect(closed).not.toHaveProperty('applicationUrlValidatedAt');

    const alternateUrl = 'https://careers.acme.test/role-1-reopened';
    const alternateReference = { ...closed.sourceReferences[0]!, applyUrl: alternateUrl };
    const alternateJob = { ...closed, applyUrl: alternateUrl, normalizedUrl: alternateUrl,
      sourceReferences: [alternateReference] };
    await jobs.putInternship(alternateJob);
    const [alternateOccurrence] = await jobs.getSourceOccurrences(reference.sourceId);
    await jobs.putSourceOccurrence({ ...alternateOccurrence!, occurrence: {
      ...alternateOccurrence!.occurrence, applyUrl: alternateUrl, admission: alternateReference.admission,
    }, changedAt: '2026-08-30T00:30:00Z' });
    const alternateMessage = { ...message, candidateUrl: alternateUrl };
    await persistDestinationAdmission({ jobs, operations, message: alternateMessage, job: alternateJob, reference: alternateReference,
      reachability: 'live', inspectedAt: '2026-08-30T01:00:00Z', browserVisible: true,
      evidence: { url: alternateUrl, title: reference.title, postingIdPresent: true, jobPostingCount: 1,
        confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] } } });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ open: true, applyUrl: alternateUrl,
      applicationUrlValidatedAt: '2026-08-30T01:00:00Z',
      admission: { catalogEligible: true, alertEligible: true } });
    expect(await jobs.getJob(current.jobId)).not.toHaveProperty('invalidApplicationUrl');
  });

  it('maps browser response statuses before inspecting stale page content', () => {
    expect(reachabilityFromHttpStatus(404)).toBe('gone');
    expect(reachabilityFromHttpStatus(410)).toBe('gone');
    expect(reachabilityFromHttpStatus(403)).toBe('blocked');
    expect(reachabilityFromHttpStatus(503)).toBe('unreachable');
    expect(reachabilityFromHttpStatus(200)).toBe('live');
  });

  it('recognizes queued verification work already covered by browser evidence', () => {
    const current = job();
    const verified = admission(true);
    verified.destination = { ...verified.destination, browserVisible: true, provider: 'greenhouse', tenant: 'acme',
      expectedPostingId: 'role-1', inspectedAt: '2026-08-28T00:05:00Z' };
    current.sourceReferences = [{ sourceId: 'community-list', externalId: 'row-1', provenance: 'reviewed-community',
      document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: 1, company: current.company, title: current.title,
      location: current.location, season: current.season, applyUrl: current.applyUrl, compensation: current.compensation,
      state: 'open', admission: verified }];
    const request = { sourceId: 'community-list', externalId: 'row-1', candidateUrl: current.applyUrl,
      providerIdentity: { provider: 'greenhouse' as const, sourceId: 'community-list', sourceUrl: 'https://github.com/example/jobs',
        tenant: 'acme', postingId: 'role-1' } };
    expect(matchingBrowserDestination(current, request, '2026-08-28T00:00:00Z')).toEqual(verified.destination);
    expect(matchingBrowserDestination(current, request, '2026-08-28T00:10:00Z')).toBeUndefined();
    expect(matchingBrowserDestination(current, { ...request, candidateUrl: `${current.applyUrl}?changed=1` })).toBeUndefined();
  });

  it('lets rendered posting proof attribute a reviewed community occurrence', async () => {
    const { admission: operations, jobs } = subject();
    await operations.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-28T00:00:00Z',
      reviewedBy: 'reviewer' }, '2026-08-28T00:00:00Z');
    await operations.supersedeEmployerMapping({ id: 'community-acme', provider: 'greenhouse', scope: 'employer:acme',
      canonicalEmployerId: 'acme', reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' });
    const reference = {
      sourceId: 'community-list', provenance: 'reviewed-community' as const, externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027',
      applyUrl: 'https://careers.acme.test/openings?gh_jid=1234567', compensation: { raw: '' }, state: 'open' as const,
    };
    const current = { ...job(), sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot',
      changedAt: '2026-08-28T00:00:00Z', firstObservedAt: '2026-08-28T00:00:00Z', firstObservedAtPrecision: 'exact' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'greenhouse', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, employerScope: 'employer:acme', postingId: '1234567' },
      candidateUrl: reference.applyUrl, reason: 'first-sight', queuedAt: '2026-08-28T00:00:00Z' };
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'live',
      inspectedAt: '2026-08-28T00:01:00Z', browserVisible: true, evidence: {
        url: reference.applyUrl, title: reference.title, contentExcerpt: `${reference.title} ${'Role details. '.repeat(30)}`,
        postingIdPresent: true, applicationFormPresent: true,
        confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] },
      } });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ admission: { postingAttribution: 'attributed',
      catalogEligible: true, alertEligible: true }, sourceReferences: [{ admission: { postingAttribution: 'attributed' } }] });
  });

  it('detects identical rendered artifacts observed for different posting IDs', async () => {
    const { admission: store } = subject();
    await store.recordVerificationAttempt({ id: 'attempt-1', jobId: 'job-1', sourceId: 'greenhouse-acme',
      candidateUrl: 'https://careers.acme.test/openings?gh_jid=1111111', state: 'succeeded',
      classification: 'unresolved', attemptedAt: '2026-08-28T00:00:00Z', completedAt: '2026-08-28T00:00:01Z' }, {
      hash: 'artifact-record-1', classification: 'unresolved', observedAt: '2026-08-28T00:00:01Z',
      value: { renderedEvidenceHash: 'same-shell', expectedPostingId: '1111111' },
    });
    await expect(store.hasRenderedEvidenceCollision('job-2', 'same-shell', '2222222')).resolves.toBe(true);
    await expect(store.hasRenderedEvidenceCollision('job-2', 'same-shell', '1111111')).resolves.toBe(false);
    await expect(store.hasRenderedEvidenceCollision('job-1', 'same-shell', '2222222')).resolves.toBe(false);
  });

  it('finds recent verification attempts only for the same job, source, and URL', async () => {
    const { admission: store } = subject();
    await store.recordVerificationAttempt({ id: 'attempt-1', jobId: 'job-1', sourceId: 'community-list',
      candidateUrl: 'https://careers.acme.test/role-1', state: 'failed', classification: 'unresolved',
      error: 'Navigation timeout', attemptedAt: '2026-08-28T00:00:00Z', completedAt: '2026-08-28T00:00:20Z' });
    await expect(store.hasVerificationAttemptSince('job-1', 'community-list', 'https://careers.acme.test/role-1',
      '2026-08-27T00:00:00Z')).resolves.toBe(true);
    await expect(store.hasVerificationAttemptSince('job-1', 'community-list', 'https://careers.acme.test/role-1',
      '2026-08-28T00:00:21Z')).resolves.toBe(false);
    await expect(store.hasVerificationAttemptSince('job-1', 'other-source', 'https://careers.acme.test/role-1',
      '2026-08-27T00:00:00Z')).resolves.toBe(false);
    await expect(store.hasVerificationAttemptSince('job-1', 'community-list', 'https://careers.acme.test/role-2',
      '2026-08-27T00:00:00Z')).resolves.toBe(false);
  });

  it('applies an exact staged repair silently and rolls back on a changed source row', async () => {
    const { database, admission: store, jobs } = subject();
    await jobs.putInternship(job());
    const preview = await store.stageRepair([{ jobId: 'job-1', admission: admission(true), company: 'Acme, Inc.' }], '2026-08-26T12:00:00Z');
    const before = await jobs.getJob('job-1');
    const result = await store.applyRepair(preview.repairToken, preview.changed, '2026-08-26T12:05:00Z');
    const after = await jobs.getJob('job-1');
    expect(result).toEqual({ changed: 1, occurrencesChanged: 0, projectionRefreshRequired: true, verificationMismatches: 0 });
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

  it('repairs occurrence admission and metadata without changing linked durable state', async () => {
    const { database, admission: store, jobs } = subject();
    const reference = {
      sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme',
      title: 'Software Intern…', location: 'Westerville, OH, Unite...', locations: ['Westerville, OH, Unite...'],
      season: 'summer-2027', applyUrl: 'https://careers.acme.test/role-1', compensation: { raw: '' },
      state: 'open' as const, admission: admission(false),
    };
    const current = { ...job(), sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'original-snapshot',
      changedAt: '2026-08-20T00:00:00Z', firstObservedAt: '2026-08-01T00:00:00Z', firstObservedAtPrecision: 'exact' });
    database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('POSTING_ALIAS#greenhouse:acme:role-1', 'CLAIM', 'posting-alias', ?)")
      .run(JSON.stringify({ alias: 'greenhouse:acme:role-1', canonicalJobId: current.jobId }));
    database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('TOMBSTONE#user-1', 'ROLE#job-1', 'notification-tombstone', ?)")
      .run(JSON.stringify({ jobId: current.jobId, deletedAt: '2026-08-21T00:00:00Z' }));
    database.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES ('user-1', 'APPLICATION#job-1', 'application', ?)")
      .run(JSON.stringify({ jobId: current.jobId, status: 'applied' }));
    database.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES ('user-1', 'RECEIPT#one', 'receipt', ?)")
      .run(JSON.stringify({ jobId: current.jobId, updatedAt: '2026-08-22T00:00:00Z' }));
    const durableBefore = database.prepare("SELECT pk, sk, kind, value FROM catalog_items WHERE kind IN ('posting-alias','notification-tombstone') ORDER BY pk").all();
    const usersBefore = database.prepare('SELECT user_id, item_key, kind, value FROM user_items ORDER BY item_key').all();
    const repairedReference = { ...reference, title: 'Software Engineering Intern', location: 'Westerville, OH, United States',
      locations: ['Westerville, OH, United States'], admission: admission(true) };
    const preview = await store.stageRepair([{ jobId: current.jobId, admission: admission(true),
      title: repairedReference.title, location: repairedReference.location, locations: repairedReference.locations,
      sourceReferences: [repairedReference] }], '2026-08-28T00:00:00Z');
    expect(preview).toMatchObject({ changed: 1, candidates: ['job-1'], occurrencesChanged: 1,
      occurrenceCandidates: ['greenhouse-acme:role-1'] });
    await store.applyRepair(preview.repairToken, preview.changed, '2026-08-28T00:05:00Z', preview.occurrencesChanged);
    expect(await jobs.getJob(current.jobId)).toMatchObject({ jobId: current.jobId, title: repairedReference.title,
      location: repairedReference.location, admission: { catalogEligible: true },
      sourceReferences: [{ title: repairedReference.title, admission: { catalogEligible: true } }],
      notification: current.notification });
    expect(await jobs.getSourceOccurrences(reference.sourceId)).toMatchObject([{ jobId: current.jobId,
      firstObservedAt: '2026-08-01T00:00:00Z', changedSnapshotHash: 'original-snapshot',
      occurrence: { title: repairedReference.title, admission: { catalogEligible: true } } }]);
    expect(database.prepare("SELECT pk, sk, kind, value FROM catalog_items WHERE kind IN ('posting-alias','notification-tombstone') ORDER BY pk").all())
      .toEqual(durableBefore);
    expect(database.prepare('SELECT user_id, item_key, kind, value FROM user_items ORDER BY item_key').all()).toEqual(usersBefore);
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 0 });
  });
});
