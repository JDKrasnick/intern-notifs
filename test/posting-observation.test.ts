import { describe, expect, it } from 'vitest';
import { buildPostingIdentity } from '../src/identity/posting.js';
import { postingObservationProjection } from '../src/identity/projection.js';
import { sourceOccurrenceKey } from '../src/identity/source-occurrence.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { CatalogAdmission, Internship, PostingIdentityDecision, SourceOccurrenceState } from '../src/types.js';

const at = '2026-08-29T12:00:00.000Z';

function decision(exactKey: string): Extract<PostingIdentityDecision, { status: 'confirmed' }> {
  return {
    status: 'confirmed', exactKey, evidenceKind: 'immutable-provider-id', provider: 'ashby', tenant: 'acme',
    contractId: 'posting-provider-ashby', contractVersion: 1, approvalReference: 'registry:ashby:v1',
    evidenceHash: exactKey, observedAt: at,
  };
}

function admission(evaluatedAt: string, browserVisible?: boolean): CatalogAdmission {
  return {
    employerResolution: 'resolved', postingAttribution: 'attributed',
    destination: {
      classification: 'application-form', candidateUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/application',
      provider: 'ashby', tenant: 'acme', expectedPostingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      inspectedAt: evaluatedAt, ...(browserVisible === undefined ? {} : { browserVisible }),
    },
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt, evidenceObservedAt: evaluatedAt,
  };
}

function observation(jobId: string, sourceId: string, externalId: string, identity: Internship['postingIdentity']): { job: Internship; occurrence: SourceOccurrenceState } {
  const occurrence = {
    sourceId, externalId, document: externalId, sourceUrl: 'https://source.example.test', row: 1,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: identity!.canonicalApplicationUrl, compensation: { raw: '' }, state: 'open' as const,
    postingIdentityDecision: decision(`provider:${identity!.provider}:${identity!.tenant}:${identity!.providerPostingId}`),
  };
  return {
    job: {
      jobId, company: occurrence.company, title: occurrence.title, location: occurrence.location, season: occurrence.season,
      applyUrl: occurrence.applyUrl, normalizedUrl: occurrence.applyUrl, fingerprint: jobId, compensation: occurrence.compensation,
      sourceReferences: [occurrence], postingIdentity: identity, postingIdentityStatus: 'confirmed', technical: true, open: true,
      firstSeenAt: at, catalogVisibleAt: at, lastSeenAt: at, notification: { smsPending: true, digestPending: true },
    },
    occurrence: {
      sourceId, externalId, jobId, occurrence, present: true, consecutiveOmissions: 0,
      changedSnapshotHash: 'snapshot', changedAt: at, firstObservedAt: at, firstObservedAtPrecision: 'exact',
    },
  };
}

describe('atomic posting observation commit', () => {
  it('keeps document coordinates as identity only for legacy references without external IDs', () => {
    const base = observation('legacy', 'community-list', 'temporary', buildPostingIdentity({
      applicationUrl: 'https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    })).occurrence.occurrence;
    const first = { ...base, externalId: undefined, document: 'README.md', row: 10 };
    const second = { ...base, externalId: undefined, document: 'README.md', row: 11 };

    expect(sourceOccurrenceKey(first)).not.toBe(sourceOccurrenceKey(second));
  });

  it('updates one durable source occurrence when its document row moves', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const first = observation(identity.canonicalJobId, 'community-list', 'stable-role', identity);
    first.job.sourceReferences = [{
      ...first.job.sourceReferences[0]!, document: 'README.md', row: 42,
      firstAttachedAt: '2026-08-01T00:00:00.000Z', firstAttachedAtPrecision: 'exact',
      providerEvidence: {
        provider: 'lever', tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sourceId: 'community-list', urls: ['https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
      },
    }];
    const moved = observation(identity.canonicalJobId, 'community-list', 'stable-role', identity);
    moved.job.sourceReferences = [{
      ...moved.job.sourceReferences[0]!, document: 'README.md', row: 57,
      firstAttachedAt: '2026-08-29T00:00:00.000Z', firstAttachedAtPrecision: 'unknown',
      providerEvidence: {
        provider: 'lever', tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sourceId: 'community-list', urls: ['https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/apply'],
      },
    }];
    moved.occurrence.occurrence = moved.job.sourceReferences[0]!;

    const projected = postingObservationProjection(first.job, moved.job, moved.occurrence);

    expect(projected.sourceReferences).toEqual([expect.objectContaining({
      sourceId: 'community-list', externalId: 'stable-role', document: 'README.md', row: 57,
      firstAttachedAt: '2026-08-01T00:00:00.000Z', firstAttachedAtPrecision: 'exact',
      providerEvidence: { urls: [
        'https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/apply',
      ], provider: 'lever', tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sourceId: 'community-list' },
    })]);
  });

  it('preserves newer browser admission when a stale source observation commits later', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const verified = observation(identity.canonicalJobId, 'community-list', 'stable-role', identity);
    const browserAdmission = admission('2026-08-29T12:00:47.000Z', true);
    verified.job.sourceReferences[0] = { ...verified.job.sourceReferences[0]!, admission: browserAdmission };

    const stale = observation(identity.canonicalJobId, 'community-list', 'stable-role', identity);
    const staleAdmission = admission('2026-08-29T12:00:28.000Z');
    stale.job.sourceReferences[0] = { ...stale.job.sourceReferences[0]!, admission: staleAdmission };
    stale.occurrence.occurrence = stale.job.sourceReferences[0]!;

    const projected = postingObservationProjection(verified.job, stale.job, stale.occurrence);

    expect(projected.sourceReferences[0]?.admission).toEqual(browserAdmission);
  });

  it('keeps the official presentation season when a community observation commits later', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const official = observation(identity.canonicalJobId, 'ashby-acme', 'official', identity);
    official.job.season = 'summer-2027';
    official.job.sourceReferences[0] = { ...official.job.sourceReferences[0]!, provenance: 'official-ats', season: 'summer-2027' };
    official.occurrence.occurrence = official.job.sourceReferences[0]!;
    const community = observation(identity.canonicalJobId, 'community-list', 'community', identity);
    community.job.season = '2027';
    community.job.sourceReferences[0] = { ...community.job.sourceReferences[0]!, provenance: 'reviewed-community', season: '2027' };
    community.occurrence.occurrence = community.job.sourceReferences[0]!;

    expect(postingObservationProjection(official.job, community.job, community.occurrence).season).toBe('summer-2027');
  });

  it('commits aliases, job, occurrence, and the canonical notification tombstone together', async () => {
    const store = new MemoryInternshipStore();
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const first = observation(identity.canonicalJobId, 'official', 'a', identity);
    const second = observation(identity.canonicalJobId, 'community', 'b', identity);
    const event = { eventId: 'canonical-event', sourceId: 'official', externalId: 'a', jobId: identity.canonicalJobId, kind: 'new-job' as const, createdAt: at };
    const [left, right] = await Promise.all([
      store.commitPostingObservation({ decision: first.occurrence.occurrence.postingIdentityDecision as Exclude<PostingIdentityDecision, { status: 'quarantined' }>, identity, ...first, notificationEvent: event }),
      store.commitPostingObservation({ decision: second.occurrence.occurrence.postingIdentityDecision as Exclude<PostingIdentityDecision, { status: 'quarantined' }>, identity, ...second, notificationEvent: event }),
    ]);
    expect([left, right].filter((result) => result.outcome === 'committed' && result.notificationInserted)).toHaveLength(1);
    expect(store.jobs.size).toBe(1);
    expect(store.jobs.get(identity.canonicalJobId)?.sourceReferences.map((reference) => reference.sourceId).sort())
      .toEqual(['community', 'official']);
    expect(store.occurrences.size).toBe(2);
    expect(store.notificationEvents.size).toBe(1);
    expect(store.postingAliases.size).toBeGreaterThan(1);
  });

  it('quarantines only a contradictory incoming occurrence and leaves the canonical role untouched', async () => {
    const store = new MemoryInternshipStore();
    const firstIdentity = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const first = observation('oldest-job', 'official', 'a', { ...firstIdentity, canonicalJobId: 'oldest-job' });
    await store.commitPostingObservation({ decision: first.occurrence.occurrence.postingIdentityDecision as Exclude<PostingIdentityDecision, { status: 'quarantined' }>, identity: first.job.postingIdentity, ...first });
    const conflictingIdentity = buildPostingIdentity({
      applicationUrl: firstIdentity.canonicalApplicationUrl,
      reviewedProviderReferences: [{ provider: 'workday', tenant: 'acme', postingId: 'req-2' }],
    });
    const incoming = observation('incoming-job', 'community', 'b', { ...conflictingIdentity, canonicalJobId: 'incoming-job' });
    const result = await store.commitPostingObservation({ decision: incoming.occurrence.occurrence.postingIdentityDecision as Exclude<PostingIdentityDecision, { status: 'quarantined' }>, identity: incoming.job.postingIdentity, ...incoming });
    expect(result.outcome).toBe('quarantined');
    expect(store.jobs.has('oldest-job')).toBe(true);
    expect(store.jobs.has('incoming-job')).toBe(false);
    expect(store.occurrences.has('community#b')).toBe(false);
    expect(store.postingIdentityIncidents.size).toBe(1);
  });

  it('rejects a preferred confirmed job that already owns another exact identity', async () => {
    const store = new MemoryInternshipStore();
    const firstIdentity = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const first = observation('existing', 'official', 'a', { ...firstIdentity, canonicalJobId: 'existing' });
    await store.commitPostingObservation({
      decision: first.occurrence.occurrence.postingIdentityDecision as Exclude<PostingIdentityDecision, { status: 'quarantined' }>,
      identity: first.job.postingIdentity, ...first,
    });
    const secondIdentity = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    await expect(store.resolvePostingIdentity(secondIdentity, 'existing')).resolves.toMatchObject({
      outcome: 'quarantine', reason: 'aliases-resolve-to-different-jobs',
    });
  });
});
