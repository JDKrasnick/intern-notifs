import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { persistDestinationAdmission, reachabilityFromHttpStatus, type DestinationVerificationMessage } from '../cloudflare/destination-verification.js';
import { evaluateCatalogAdmission } from '../src/catalog-admission.js';
import { classifyDestination, matchingBrowserDestination } from '../src/destination-verification.js';
import { processPosting } from '../src/ingestion/processor.js';
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
    '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, db, admission: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

describe('D1 catalog admission operations', () => {
  it.each([
    ['Tesla', 'tesla', 'tesla', 'https://www.tesla.com/careers/search/job/software-engineer-intern-275558'],
    ['Meta', 'meta', 'meta', 'https://www.metacareers.com/jobs/1027438186737957'],
    ['Jane Street', 'janestreet', 'jane-street', 'https://www.janestreet.com/join-jane-street/position/8599644002'],
    ['Goldman Sachs', 'goldman-sachs', 'goldman-sachs', 'https://higher.gs.com/roles/171567'],
    ['IMC', 'imc', 'imc', 'https://www.imc.com/us/careers/jobs/4823924101'],
  ] as const)('admits a new reviewed-community %s role through its official provider mapping', async (
    company, provider, canonicalEmployerId, applyUrl,
  ) => {
    const current = subject();
    const migration = readFileSync(new URL('../cloudflare/migrations/0012_official_career_provider_identity.sql', import.meta.url), 'utf8');
    current.database.exec(migration);
    current.database.exec(migration);
    const listing = processPosting({
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: `${provider}-role`,
      sourceUrl: 'https://github.com/example/jobs', fetchedAt: '2026-09-01T12:00:00Z',
      employer: { name: company, authority: 'source-row' }, title: 'Software Engineering Intern',
      content: [{ kind: 'description', format: 'plain', value: 'Build production software.' }],
      locations: ['New York, NY'], applyUrl, sourceState: 'open', lifecycleAuthority: 'source',
    }).listing!;
    expect(listing.providerIdentity).toMatchObject({ provider, tenant: provider });
    const canonicalEmployer = await current.admission.resolveCanonicalEmployer(listing.providerIdentity!);
    expect(canonicalEmployer).toEqual({ id: canonicalEmployerId, displayName: company });
    const reviewed = {
      ...listing,
      employerEvidence: { authority: 'reviewed-registry' as const, canonicalEmployer: canonicalEmployer! },
    };
    const destination = classifyDestination({
      listing: reviewed, reachability: 'implied', inspectedAt: '2026-09-01T12:00:00Z',
    });
    expect(destination.classification).toBe('posting-detail');
    expect(evaluateCatalogAdmission({
      listing: reviewed, destination, postingAttributed: true, evaluatedAt: '2026-09-01T12:00:00Z',
    })).toMatchObject({ employerResolution: 'resolved', catalogEligible: true, alertEligible: true, reasonCodes: [] });
  });

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
    }];
    await jobs.putInternship(current);

    await expect(store.legacyVerificationCandidates()).resolves.toEqual([{
      jobId: current.jobId, sourceId: 'community-list', externalId: 'row-1',
      candidateUrl: 'https://careers.acme.test/openings?gh_jid=7654321',
      providerIdentity: { provider: 'greenhouse', sourceId: 'community-list', sourceUrl: 'https://github.com/example/jobs',
        employerScope: 'employer:acme', postingId: '7654321' },
    }]);
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

  it('retires JSON-LD metadata that disappears from a refreshed exact page', async () => {
    const { admission: operations, jobs, database } = subject();
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
      candidateUrl: reference.applyUrl, reason: 'first-sight', queuedAt: '2026-08-28T00:00:00Z', metadataExtractionVersion: 1 };
    const pageEvidence = {
      url: reference.applyUrl, title: reference.title, contentExcerpt: `${reference.title} ${'Role details. '.repeat(30)}`,
      postingIdPresent: true, applicationFormPresent: true,
      confidence: { score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['browser-visible evidence'] },
    };
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'live',
      inspectedAt: '2026-08-28T00:01:00Z', browserVisible: true, evidence: { ...pageEvidence,
        metadataArtifacts: [{ title: reference.title, identifier: '1234567', compensationText: 'USD $40-$50/hour' }] } });
    const enriched = (await jobs.getJob(current.jobId))!;
    expect(enriched.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 50 });

    const enrichedReference = enriched.sourceReferences[0]!;
    await persistDestinationAdmission({ jobs, operations, message: { ...message, metadataBackfillToken: 'collection-1' },
      job: enriched, reference: enrichedReference, reachability: 'live',
      inspectedAt: '2026-08-29T00:01:00Z', browserVisible: true, evidence: pageEvidence });

    expect((await jobs.getJob(current.jobId))?.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 50 });
    expect(database.prepare("SELECT count(*) AS count FROM role_metadata_evidence WHERE source_class = 'official-json-ld' AND is_current = 1").get())
      .toEqual({ count: 0 });
    const plan = await operations.stageRoleMetadataRepair('2026-08-29T00:02:00Z');
    expect(plan.expectedJobs).toBe(1);
    await operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, plan.expectedOccurrences, '2026-08-29T00:03:00Z');
    const refreshed = (await jobs.getJob(current.jobId))!;
    expect(refreshed.compensation).toEqual({ raw: '' });
    expect(refreshed.sourceReferences[0]?.metadataEvidence?.some((item) => item.sourceClass === 'official-json-ld')).toBe(false);
    expect((await operations.roleMetadataAudit()).projectionOnlyOmissions).toEqual([]);
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
    expect(result).toEqual({ changed: 1, occurrencesChanged: 0, projectionRefreshRequired: true });
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
