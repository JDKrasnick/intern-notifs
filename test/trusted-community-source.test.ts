import { describe, expect, it } from 'vitest';
import simplifyBaselineReport from '../docs/trusted-community/simplify-summer-2026-baseline.json' with { type: 'json' };
import { deriveCanonicalAdmission, evaluateCatalogAdmission } from '../src/catalog-admission.js';
import { CatalogReconciler } from '../src/ingestion/catalog-reconciler.js';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import { trustedCommunityBaselineReport } from '../src/sources/trusted-community-baseline.js';
import {
  activeTrustedCommunityPolicy,
  advanceTrustedCommunityQualification,
  effectiveAdmissionConfigurationVersion,
  sourceAdmissionPolicy,
  type TrustedCommunityAdmissionPolicy,
} from '../src/sources/trust-policy.js';
import {
  SIMPLIFY_TRUSTED_COMMUNITY_BASELINE,
  SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS,
  trustedCommunityCircuitBreaches,
  trustedCommunityMetrics,
  trustedCommunityThresholds,
} from '../src/sources/trusted-community-health.js';
import type {
  CatalogAdmission,
  DestinationEvidence,
  Internship,
  PostingIdentityDecision,
  ProcessedListing,
  SourceOccurrenceState,
  SourceAdapter,
  SourceFetchResult,
} from '../src/types.js';

const inspectedAt = '2026-09-04T12:00:00.000Z';
const policy: TrustedCommunityAdmissionPolicy = {
  trust: 'trusted-community', version: 'test-v2',
  catalogMode: 'validated-posting-specific-destination',
  alertMode: 'exact-identity-or-two-complete-snapshots',
};

function destination(overrides: Partial<DestinationEvidence> = {}): DestinationEvidence {
  return {
    classification: 'posting-detail',
    candidateUrl: 'https://careers.example.test/jobs/role-1?utm_source=simplify',
    finalUrl: 'https://careers.example.test/jobs/role-1',
    provider: 'unknown', expectedPostingId: 'role-1', inspectedAt,
    ...overrides,
  };
}

function unconfirmed(): PostingIdentityDecision {
  return { status: 'unconfirmed', reason: 'unrecognized-url-family', reviewFamilyKey: 'example.test/jobs', observedAt: inspectedAt };
}

function listing(overrides: Partial<ProcessedListing> = {}): ProcessedListing {
  return {
    sourceId: 'simplify-summer-2026', provenance: 'reviewed-community', externalId: 'README.md:https://careers.example.test/jobs/role-1',
    document: 'README.md', sourceUrl: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md', row: 12,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
    applyUrl: 'https://careers.example.test/jobs/role-1', compensation: { raw: '' }, state: 'open', fetchedAt: inspectedAt,
    technical: true, postingIdentityDecision: unconfirmed(),
    employerEvidence: { authority: 'source-row' },
    providerIdentity: { provider: 'github', sourceId: 'simplify-summer-2026', sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', postingId: 'role-1' },
    metadataCompleteness: { complete: true, title: 'complete', location: 'complete' },
    ...overrides,
  };
}

function admission(alertEligible: boolean): CatalogAdmission {
  return {
    employerResolution: 'source-reported', postingAttribution: 'unattributed', destination: destination(),
    metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible: true, alertEligible,
    reasonCodes: ['employer-unresolved', 'posting-unattributed'], evidenceCodes: ['trusted-community-source'],
    evaluatedAt: inspectedAt, evidenceObservedAt: inspectedAt,
  };
}

describe('trusted community source policy', () => {
  it('trusts only the explicitly configured Simplify source behind the catalog gate', () => {
    expect(sourceAdmissionPolicy('simplify-summer-2026')).toMatchObject({ trust: 'trusted-community', alertMode: 'disabled' });
    expect(sourceAdmissionPolicy('vanshb03-summer-2027')).toEqual({ trust: 'standard', version: 'standard-v1' });
    expect(activeTrustedCommunityPolicy('simplify-summer-2026', false)).toBeUndefined();
    expect(activeTrustedCommunityPolicy('simplify-summer-2026', true)).toBeDefined();
  });

  it('includes both source policy and catalog gate state in the effective configuration version', () => {
    const off = effectiveAdmissionConfigurationVersion({ sourceId: 'simplify-summer-2026', resolverVersion: 'registry-v1', trustedCommunityCatalogEnabled: false });
    const on = effectiveAdmissionConfigurationVersion({ sourceId: 'simplify-summer-2026', resolverVersion: 'registry-v1', trustedCommunityCatalogEnabled: true });
    expect(off).not.toBe(on);
    expect(effectiveAdmissionConfigurationVersion({ sourceId: 'ordinary', trustedCommunityCatalogEnabled: true })).toBeUndefined();
  });

  it('admits validated source-reported roles without inventing a canonical employer', () => {
    const qualification = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 1 });
    const result = evaluateCatalogAdmission({ listing: listing(), destination: destination(), postingAttributed: false, evaluatedAt: inspectedAt,
      trustedCommunity: { policy, qualification } });
    expect(result).toMatchObject({
      employerResolution: 'source-reported', catalogEligible: true, alertEligible: false,
      reasonCodes: ['employer-unresolved', 'posting-unattributed'], evidenceCodes: ['trusted-community-source'],
    });
    expect(result.canonicalEmployer).toBeUndefined();

    const canonical = evaluateCatalogAdmission({ listing: listing({ employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'acme', displayName: 'Acme' } } }),
      destination: destination(), postingAttributed: true, evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification } });
    expect(canonical).toMatchObject({ employerResolution: 'resolved', canonicalEmployer: { id: 'acme' } });

    const sourceReported = { ...listing(), admission: result };
    const official = { ...listing({ sourceId: 'greenhouse-acme', provenance: 'official-ats', admission: canonical }), admission: canonical };
    expect(deriveCanonicalAdmission([sourceReported, official], inspectedAt)).toMatchObject({
      employerResolution: 'resolved', canonicalEmployer: { id: 'acme' },
    });
  });

  it('still blocks generic source-reported employer metadata', () => {
    const qualification = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 1 });
    const result = evaluateCatalogAdmission({ listing: listing({ company: 'External Careers' }), destination: destination(),
      postingAttributed: false, evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification } });
    expect(result).toMatchObject({ employerResolution: 'source-reported', catalogEligible: false });
    expect(result.reasonCodes).toContain('employer-generic-label');
  });

  it.each(['aggregate-board', 'gone', 'blocked-uninspectable', 'unresolved'] as const)(
    'gives trusted roles no grace for a %s destination',
    (classification) => {
      const prior = admission(false);
      const nextDestination = destination({ classification });
      const qualification = advanceTrustedCommunityQualification({ destination: nextDestination, postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2 });
      const result = evaluateCatalogAdmission({ listing: listing(), destination: nextDestination, postingAttributed: false,
        evaluatedAt: inspectedAt, previous: prior, trustedCommunity: { policy, qualification } });
      expect(result.catalogEligible).toBe(false);
      expect(result.reasonCodes).not.toContain('destination-grace');
    },
  );

  it('counts each complete fetch once, including unchanged bodies, and excludes 304/retry replays', () => {
    const first = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 7 });
    const retry = advanceTrustedCommunityQualification({ previous: first, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 7 });
    const notModified = advanceTrustedCommunityQualification({ previous: retry, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode });
    const second = advanceTrustedCommunityQualification({ previous: notModified, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 8 });
    const settled = advanceTrustedCommunityQualification({ previous: second, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 9 });
    expect(first).toMatchObject({ consecutiveCompleteSnapshots: 1, status: 'pending' });
    expect(retry.consecutiveCompleteSnapshots).toBe(1);
    expect(notModified.consecutiveCompleteSnapshots).toBe(1);
    expect(second).toMatchObject({ consecutiveCompleteSnapshots: 2, status: 'eligible', basis: 'two-complete-snapshots' });
    expect(settled).toMatchObject({ consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 8 });
  });

  it('resets on a changed destination, fast-tracks exact identity, and preserves permanent baseline suppression', () => {
    const first = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 1, baselineSuppressed: true });
    const changed = advanceTrustedCommunityQualification({ previous: first, destination: destination({ candidateUrl: 'https://careers.example.test/jobs/role-2', finalUrl: 'https://careers.example.test/jobs/role-2' }), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2 });
    expect(changed).toMatchObject({ consecutiveCompleteSnapshots: 1, status: 'pending', baselineSuppressed: true });

    const confirmed: PostingIdentityDecision = { status: 'confirmed', exactKey: 'provider:tenant:role-2', evidenceKind: 'immutable-provider-id', provider: 'greenhouse', tenant: 'acme', contractId: 'reviewed', contractVersion: 1, approvalReference: 'review', evidenceHash: 'hash', observedAt: inspectedAt };
    const exact = advanceTrustedCommunityQualification({ previous: changed, destination: changedDestination(), postingIdentityDecision: confirmed, alertMode: policy.alertMode, completeFetchSequence: 3 });
    expect(exact).toMatchObject({ status: 'eligible', basis: 'exact-identity', baselineSuppressed: true });
  });

  it('lets browser validation after the second snapshot use the same counted candidate history', () => {
    const unresolved = destination({ classification: 'unresolved', finalUrl: undefined });
    const first = advanceTrustedCommunityQualification({ destination: unresolved, postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 1 });
    const second = advanceTrustedCommunityQualification({ previous: first, destination: unresolved, postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2 });
    const browser = advanceTrustedCommunityQualification({ previous: second, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode });
    expect(browser).toMatchObject({ consecutiveCompleteSnapshots: 2, status: 'eligible', basis: 'two-complete-snapshots' });
  });

  it('keeps browser publication suppressed until the complete migration clears it', () => {
    const migrating = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 1, catalogPublicationSuppressed: true });
    const browser = advanceTrustedCommunityQualification({ previous: migrating, destination: destination(),
      postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode });
    const held = evaluateCatalogAdmission({ listing: listing(), destination: destination(), postingAttributed: false,
      evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification: browser } });
    expect(browser.catalogPublicationSuppressed).toBe(true);
    expect(held.catalogEligible).toBe(false);

    const completed = advanceTrustedCommunityQualification({ previous: browser, destination: destination(),
      postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2,
      catalogPublicationSuppressed: false });
    expect(completed.catalogPublicationSuppressed).toBe(false);
    expect(evaluateCatalogAdmission({ listing: listing(), destination: destination(), postingAttributed: false,
      evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification: completed } }).catalogEligible).toBe(true);
  });
});

describe('trusted community source health', () => {
  it('derives every route metric from technically eligible listings only', () => {
    const technicalExact = listing({
      applyUrl: 'https://jobs.lever.co/acme/role-1',
      providerIdentity: {
        provider: 'lever', sourceId: 'simplify-summer-2026',
        sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', tenant: 'acme', postingId: 'role-1',
      },
    });
    const technicalBrowser = listing({
      externalId: 'README.md:https://careers.example.test/openings',
      applyUrl: 'https://careers.example.test/openings',
    });
    const shelvedExact = listing({
      externalId: 'README.md:https://jobs.lever.co/acme/role-3',
      applyUrl: 'https://jobs.lever.co/acme/role-3',
      technical: false,
      providerIdentity: {
        provider: 'lever', sourceId: 'simplify-summer-2026',
        sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', tenant: 'acme', postingId: 'role-3',
      },
    });
    const report = trustedCommunityBaselineReport({
      sourceId: 'simplify-summer-2026',
      generatedAt: inspectedAt,
      sourcePolicyVersion: 'test-v1',
      processed: {
        listings: [technicalExact, technicalBrowser, shelvedExact],
        decisions: [],
        counts: { raw: 3, valid: 3, eligible: 2, shelved: 1, filtered: 0, withheld: 0 },
      },
      diagnostics: { rejectedAggregatorRows: 0, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0 },
    });

    expect(report.counts).toMatchObject({
      technicallyEligibleRows: 2,
      exactRouteShapes: 1,
      browserInspectionCandidates: 1,
    });
    expect(report.rates).toMatchObject({ exactRouteShare: 0.5, browserInspectionShare: 0.5 });
  });

  it('derives explicit numeric thresholds from the recorded baseline', () => {
    expect(SIMPLIFY_TRUSTED_COMMUNITY_BASELINE).toEqual({
      rawRows: simplifyBaselineReport.counts.rawRows,
      eligibleRows: simplifyBaselineReport.counts.technicallyEligibleRows,
      destinationFailures: simplifyBaselineReport.counts.rejectedAggregatorRows,
      browserInspectionCandidates: simplifyBaselineReport.counts.browserInspectionCandidates,
      catalogAdmissions: simplifyBaselineReport.counts.technicallyEligibleRows,
      alertQualifications: simplifyBaselineReport.counts.exactRouteShapes,
    });
    expect(trustedCommunityThresholds(SIMPLIFY_TRUSTED_COMMUNITY_BASELINE)).toEqual(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS);
    expect(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS).toEqual(simplifyBaselineReport.thresholds);
  });

  it('applies structural gates immediately and rate gates only at sufficient coverage', () => {
    const thresholds = SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
    const healthy = {
      rawRows: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.rawRows,
      eligibleRows: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
      rejectedAggregatorRows: 0, survivingAggregatorRows: 0,
      duplicateOccurrenceIds: 0,
      inspectedCandidates: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
      browserInspectionCandidates: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.browserInspectionCandidates,
      destinationFailures: 0, destinationFailuresByReason: {},
      inspectionCoverage: 1,
      browserInspectionShare: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.browserInspectionCandidates
        / SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
      destinationFailureRate: 0,
      catalogYield: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.catalogAdmissions
        / SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.rawRows,
      alertYield: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.alertQualifications
        / SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
    };
    expect(trustedCommunityCircuitBreaches({ metrics: healthy, alertMode: 'exact-identity-or-two-complete-snapshots' })).toEqual([]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, duplicateOccurrenceIds: 1 }, alertMode: 'disabled' }))
      .toEqual(['1 duplicate occurrence identity row(s)']);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, inspectedCandidates: 99, inspectionCoverage: 0.05,
      destinationFailureRate: 1, browserInspectionShare: 1, catalogYield: 0, alertYield: 0 }, alertMode: 'exact-identity-or-two-complete-snapshots' }))
      .toEqual([]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, inspectedCandidates: 99, inspectionCoverage: 0.05 },
      alertMode: 'disabled', requireCompleteInspection: true })).toEqual([
      'inspected candidates 99 below 100',
      'inspection coverage 5.00% below 90.00%',
    ]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, destinationFailureRate: 0.9 }, alertMode: 'disabled' }))
      .toContain('destination failure rate exceeded');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, rawRows: 0 }, alertMode: 'disabled' }))
      .toEqual(expect.arrayContaining(['parser returned zero rows', `raw rows 0 below ${thresholds.minimumRawRows}`]));
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, survivingAggregatorRows: 1 }, alertMode: 'disabled' }))
      .toContain('1 aggregator row(s) survived rejection');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, rawRows: thresholds.minimumRawRows - 1 }, alertMode: 'disabled' }))
      .toContain(`raw rows ${thresholds.minimumRawRows - 1} below ${thresholds.minimumRawRows}`);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, eligibleRows: thresholds.minimumEligibleRows - 1 }, alertMode: 'disabled' }))
      .toContain(`eligible rows ${thresholds.minimumEligibleRows - 1} below ${thresholds.minimumEligibleRows}`);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, browserInspectionShare: 1 }, alertMode: 'disabled' }))
      .toContain('browser inspection share exceeded');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, catalogYield: 0 }, alertMode: 'disabled' }))
      .toContain('catalog yield fell below its floor');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, alertYield: 0 }, alertMode: 'disabled' }))
      .not.toContain('alert yield fell below its floor');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, alertYield: 0 }, alertMode: 'exact-identity-or-two-complete-snapshots' }))
      .toContain('alert yield fell below its floor');
  });

  it('measures underlying catalog qualification while migration publication is suppressed', () => {
    const role = listing({ admission: { ...admission(false), catalogEligible: false },
      admissionConfigurationVersion: 'policy-v1', trustedCommunityAlertQualification: {
        candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
        consecutiveCompleteSnapshots: 1, status: 'disabled', baselineSuppressed: true, catalogPublicationSuppressed: true,
      } });
    const metrics = trustedCommunityMetrics({ rawRows: 1, eligibleRows: 1, listings: [role], priorOccurrences: [],
      eligibleExternalIds: new Set([role.externalId!]), admissionConfigurationVersion: 'policy-v1',
      rejectedAggregatorRows: 0, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0 });
    expect(metrics.catalogYield).toBe(1);
  });

  it('excludes stale prior occurrences from current snapshot health metrics', () => {
    const current = listing({ externalId: 'README.md:https://careers.example.test/jobs/current' });
    const staleSuccess = listing({ externalId: 'README.md:https://careers.example.test/jobs/stale-success',
      admission: admission(false), admissionConfigurationVersion: 'policy-v1' });
    const staleFailure = listing({ externalId: 'README.md:https://careers.example.test/jobs/stale-failure',
      admission: { ...admission(false), catalogEligible: false,
        destination: destination({ classification: 'gone' }), reasonCodes: ['destination-gone'] },
      admissionConfigurationVersion: 'policy-v1' });
    const priorOccurrences = [staleSuccess, staleFailure].map((role): SourceOccurrenceState => ({
      sourceId: role.sourceId, externalId: role.externalId!, jobId: role.externalId!, occurrence: role,
      present: false, consecutiveOmissions: 1, changedSnapshotHash: 'prior', changedAt: inspectedAt,
    }));

    const metrics = trustedCommunityMetrics({
      rawRows: 1, eligibleRows: 1, listings: [], priorOccurrences,
      eligibleExternalIds: new Set([current.externalId!]), admissionConfigurationVersion: 'policy-v1',
      rejectedAggregatorRows: 0, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0,
    });

    expect(metrics).toMatchObject({
      inspectedCandidates: 0, inspectionCoverage: 0, destinationFailures: 0,
      catalogYield: 0, alertYield: 0,
    });
  });

  it('does not checkpoint or self-enqueue a migration continuation after a circuit breach', async () => {
    const store = new MemoryInternshipStore();
    const adapter: SourceAdapter = {
      id: 'simplify-summer-2026',
      async fetch(previous): Promise<SourceFetchResult> {
        const second = listing({ externalId: 'README.md:https://jobs.other.test/role-2', company: 'Other',
          title: 'Data Engineering Intern', applyUrl: 'https://jobs.other.test/role-2' });
        return { sourceId: this.id, listings: [listing(), second], notModified: false,
          checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: 2 } };
      },
    };
    const resolver = { async configurationVersion() { return 'registry-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    await new Poller([adapter], store, () => new Date(inspectedAt), undefined, undefined, undefined, undefined,
      resolver, true, false).poll();
    const checkpoint = await store.getCheckpoint(adapter.id);
    const breached = await new Poller([adapter], store, () => new Date('2026-09-04T12:10:00.000Z'), undefined,
      undefined, undefined, undefined, resolver, true, true).poll({ maxAdmissionMigrationListingsPerSourceRun: 0 });
    expect(breached.failures).toEqual([expect.stringContaining('trusted-community circuit breaker')]);
    expect(breached.continuationSources).toEqual([]);
    expect(await store.getCheckpoint(adapter.id)).toEqual(checkpoint);
    expect(await store.getSourceHealth(adapter.id)).toMatchObject({ state: 'quarantined' });
  });

  it('keeps the final migration hidden and uncheckpointed when current inspection coverage is incomplete', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'simplify-summer-2026';
    const { minimumRawRows, minimumEligibleRows } = SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
    const previous = {
      sourceId,
      successfulFetches: 1,
      lastRowCount: minimumEligibleRows,
      lastRawCount: minimumRawRows,
      contentHash: 'prior-snapshot',
      admissionConfigurationVersion: 'registry-v1',
    };
    await store.putCheckpoint(previous);
    const listings = Array.from({ length: minimumEligibleRows }, (_, index) => {
      const postingId = `role-${index}`;
      const host = index % 2 === 0 ? 'careers-a.example.test' : 'careers-b.example.test';
      return listing({
        externalId: `README.md:https://${host}/jobs/${postingId}`,
        row: index + 1,
        applyUrl: `https://${host}/jobs/${postingId}`,
        providerIdentity: {
          provider: 'github', sourceId, sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', postingId,
        },
      });
    });
    const adapter: SourceAdapter = {
      id: sourceId,
      async fetch(): Promise<SourceFetchResult> {
        return {
          sourceId,
          rawRowCount: minimumRawRows,
          listings,
          notModified: false,
          checkpoint: { sourceId, successfulFetches: 2, lastRowCount: listings.length, contentHash: 'current-snapshot' },
        };
      },
    };
    const resolver = {
      async configurationVersion() { return 'registry-v1'; },
      async resolveCanonicalEmployer(identity: ProcessedListing['providerIdentity']) {
        if (Number(identity!.postingId!.slice('role-'.length)) >= 100) throw new Error('fixture resolution failure');
        return undefined;
      },
      async resolveDestinationRule(identity: ProcessedListing['providerIdentity'], candidateUrl: string) {
        return {
          id: `rule-${identity!.postingId}`, host: new URL(candidateUrl).hostname, provider: 'github' as const,
          decision: 'standard-provider-route' as const, reviewedAt: inspectedAt, reviewedBy: 'test',
        };
      },
    };

    const result = await new Poller([adapter], store, () => new Date(inspectedAt), undefined,
      undefined, undefined, undefined, resolver, true, true).poll({ maxAdmissionMigrationListingsPerSourceRun: 0 });

    const inspectedCoverage = ((100 / minimumEligibleRows) * 100).toFixed(2);
    expect(result.failures).toContain(`simplify-summer-2026: trusted-community circuit breaker: inspection coverage ${inspectedCoverage}% below 90.00%`);
    expect(result.continuationSources).toEqual([]);
    expect(await store.getCheckpoint(sourceId)).toEqual(previous);
    expect(await store.listCatalog()).toEqual([]);
    expect(await store.getSourceHealth(sourceId)).toMatchObject({ state: 'quarantined' });
  });
});

function changedDestination() {
  return destination({ candidateUrl: 'https://careers.example.test/jobs/role-2', finalUrl: 'https://careers.example.test/jobs/role-2' });
}

describe('trusted community delayed promotion', () => {
  it('creates one deterministic event only on the first eligible transition', () => {
    const reconciler = new CatalogReconciler();
    const initialListing = listing({ admission: { ...admission(false), catalogEligible: false }, trustedCommunityAlertQualification: {
      candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
      consecutiveCompleteSnapshots: 1, lastCountedSuccessfulFetchSequence: 1, status: 'pending', baselineSuppressed: false,
    } });
    const first = reconciler.reconcile({ sourceId: initialListing.sourceId, snapshotHash: 'one', activeExternalIds: new Set([initialListing.externalId!]),
      listings: [initialListing], priorOccurrences: [], resolvedJobs: new Map(), now: inspectedAt, baseline: true });
    const existing = first.jobs[0]!;
    const prior = first.occurrences[0]!;
    const promotedListing = listing({ admission: admission(true), trustedCommunityAlertQualification: {
      ...initialListing.trustedCommunityAlertQualification!, consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 2,
      status: 'eligible', basis: 'two-complete-snapshots',
    } });
    const promoted = reconciler.reconcile({ sourceId: promotedListing.sourceId, snapshotHash: 'two', activeExternalIds: new Set([promotedListing.externalId!]),
      listings: [promotedListing], priorOccurrences: [prior], resolvedJobs: new Map([[promotedListing.externalId!, existing]]), now: '2026-09-05T12:00:00.000Z', baseline: false });
    expect(promoted.notifications).toHaveLength(1);
    expect(promoted.jobs[0]).toMatchObject({ firstSeenAt: inspectedAt, catalogRecency: 'normal',
      notification: { smsPending: true, digestPending: true } });

    const replay = reconciler.reconcile({ sourceId: promotedListing.sourceId, snapshotHash: 'three', activeExternalIds: new Set([promotedListing.externalId!]),
      listings: [promotedListing], priorOccurrences: promoted.occurrences, resolvedJobs: new Map([[promotedListing.externalId!, promoted.jobs[0]!]]), now: '2026-09-06T12:00:00.000Z', baseline: false });
    expect(replay.notifications).toHaveLength(0);
  });

  it('never promotes a baseline-suppressed occurrence', () => {
    const reconciler = new CatalogReconciler();
    const priorAdmission = { ...admission(false), catalogEligible: false };
    const role = listing({ admission: admission(true), trustedCommunityAlertQualification: {
      candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
      consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 2, status: 'eligible', basis: 'two-complete-snapshots', baselineSuppressed: true,
    } });
    const existing: Internship = { jobId: 'job-1', company: role.company, title: role.title, location: role.location, season: role.season,
      applyUrl: role.applyUrl, normalizedUrl: role.applyUrl, fingerprint: 'fp', compensation: { raw: '' }, sourceReferences: [], technical: true,
      open: true, admission: priorAdmission, firstSeenAt: inspectedAt, lastSeenAt: inspectedAt, notification: { smsPending: false, digestPending: false } };
    const prior: SourceOccurrenceState = { sourceId: role.sourceId, externalId: role.externalId!, jobId: existing.jobId,
      occurrence: { ...role, admission: priorAdmission }, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'one', changedAt: inspectedAt };
    existing.sourceReferences = [prior.occurrence];
    const result = reconciler.reconcile({ sourceId: role.sourceId, snapshotHash: 'two', activeExternalIds: new Set([role.externalId!]), listings: [role],
      priorOccurrences: [prior], resolvedJobs: new Map([[role.externalId!, existing]]), now: '2026-09-05T12:00:00.000Z', baseline: false });
    expect(result.notifications).toHaveLength(0);
    expect(result.jobs[0]).toMatchObject({ catalogRecency: 'baseline' });
  });

  it('does not promote when the final canonical admission remains hidden by an official employer conflict', () => {
    const reconciler = new CatalogReconciler();
    const priorAdmission = { ...admission(false), catalogEligible: false };
    const role = listing({ admission: admission(true), trustedCommunityAlertQualification: {
      candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
      consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 2, status: 'eligible',
      basis: 'two-complete-snapshots', baselineSuppressed: false,
    } });
    const trustedReference = { ...role, admission: priorAdmission };
    const officialAdmission = (id: string): CatalogAdmission => ({
      ...admission(true), canonicalEmployer: { id, displayName: id }, employerResolution: 'resolved',
      postingAttribution: 'attributed', reasonCodes: [], evidenceCodes: undefined,
    });
    const officialA = { ...trustedReference, sourceId: 'official-a', externalId: 'official-a',
      provenance: 'official-ats' as const, admission: officialAdmission('employer-a') };
    const officialB = { ...trustedReference, sourceId: 'official-b', externalId: 'official-b',
      provenance: 'official-structured' as const, admission: officialAdmission('employer-b') };
    const existing: Internship = {
      jobId: 'job-1', company: role.company, title: role.title, location: role.location, season: role.season,
      applyUrl: role.applyUrl, normalizedUrl: role.applyUrl, fingerprint: 'fp', compensation: { raw: '' },
      sourceReferences: [trustedReference, officialA, officialB], technical: true, open: true,
      admission: { ...priorAdmission, employerResolution: 'conflict', catalogEligible: false, alertEligible: false,
        reasonCodes: ['employer-conflict'] },
      firstSeenAt: inspectedAt, lastSeenAt: inspectedAt,
      notification: { smsPending: false, digestPending: false },
    };
    const prior: SourceOccurrenceState = {
      sourceId: role.sourceId, externalId: role.externalId!, jobId: existing.jobId,
      occurrence: trustedReference, present: true, consecutiveOmissions: 0,
      changedSnapshotHash: 'one', changedAt: inspectedAt,
    };

    const result = reconciler.reconcile({
      sourceId: role.sourceId, snapshotHash: 'two', activeExternalIds: new Set([role.externalId!]),
      listings: [role], priorOccurrences: [prior], resolvedJobs: new Map([[role.externalId!, existing]]),
      now: '2026-09-05T12:00:00.000Z', baseline: false,
    });

    expect(result.jobs[0]).toMatchObject({
      admission: { catalogEligible: false, alertEligible: false },
      notification: { smsPending: false, digestPending: false },
    });
    expect(result.jobs[0]?.admission?.reasonCodes).toContain('employer-conflict');
    expect(result.notifications).toHaveLength(0);
  });
});
