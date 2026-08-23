import { describe, expect, it } from 'vitest';
import { createCandidateRelease, createNotificationIntents, isQuietTime, logicalTombstoneId, MemoryDeliveryClaimStore, naturalTruncate, personalizeRelease, renderReleasePush } from '../src/release-notifications.js';
import type { Internship } from '../src/types.js';

function job(id: string, title: string, season = 'Summer 2027', education?: string[]): Internship {
  return {
    jobId: id, company: 'Google', title, location: 'New York, NY', season,
    applyUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`, fingerprint: id,
    compensation: { raw: '' }, sourceReferences: [], technical: true, open: true,
    firstSeenAt: '2026-08-23T12:00:00.000Z', lastSeenAt: '2026-08-23T12:00:00.000Z',
    notification: { smsPending: false, digestPending: false },
    ...(education ? { internshipIdentity: { education: { audience: education, evidence: 'explicit' } } } : {}),
  } as Internship;
}

describe('release notification pipeline domain', () => {
  it('creates deterministic bounded releases and rejects cross-employer aggregation', () => {
    const at = new Date('2026-08-23T12:00:00.000Z');
    const first = createCandidateRelease([job('2', 'ML Intern'), job('1', 'Software Intern'), job('1', 'Software Intern')], at);
    const second = createCandidateRelease([job('1', 'Software Intern'), job('2', 'ML Intern')], at);
    expect(first.releaseId).toBe(second.releaseId);
    expect(first.jobIds).toEqual(['1', '2']);
    expect(first.flushAt).toBe('2026-08-23T12:00:08.000Z');
    expect(() => createCandidateRelease([{ ...job('3', 'Product Intern'), company: 'Meta' }, job('1', 'Software Intern')], at)).toThrow(/span employers/);
    expect(() => createCandidateRelease([job('1', 'Software Intern')], at, 11)).toThrow(/1 to 10/);
  });

  it('filters before grouping and keeps unknown education visible', () => {
    const release = createCandidateRelease([
      job('1', 'Software Engineering Intern'),
      job('2', 'Frontend Software Intern'),
      job('3', 'Quant Trading Intern'),
    ], new Date('2026-08-23T12:00:00.000Z'));
    const groups = personalizeRelease(release, 'student', { includeCategories: ['swe'] });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ presentation: 'program-group', education: 'Education level not specified by employer', newlyMatchedJobIds: ['1', '2'] });
  });

  it('uses one employer release at four matches and a release deep link', () => {
    const release = createCandidateRelease(['Software', 'ML', 'Product Manager', 'Quant'].map((title, index) => job(String(index), `${title} Intern`, 'Summer 2027', ['Undergraduate'])), new Date('2026-08-23T12:00:00.000Z'));
    const grouped = personalizeRelease(release, 'student', {})[0]!;
    expect(grouped.presentation).toBe('employer-release');
    expect(renderReleasePush(grouped)).toMatchObject({ title: 'Google posted 4 matching roles', data: { destination: 'release', url: `internnotifs://releases/${release.releaseId}` } });
  });

  it('holds both channels during overnight quiet hours', () => {
    const at = new Date('2026-08-23T05:15:00.000Z'); // 01:15 in New York
    const quiet = { start: '22:00', end: '07:00', timezone: 'America/New_York' };
    expect(isQuietTime(at, quiet)).toBe(true);
    const intents = createNotificationIntents(createCandidateRelease([job('1', 'Software Intern')], at), 'student', {}, ['push', 'email'], at, quiet);
    expect(intents.map((intent) => intent.eligibleAt)).toEqual(['2026-08-23T11:00:00.000Z', '2026-08-23T11:00:00.000Z']);
  });

  it('permanently claims each device and treats unknown as terminal', () => {
    const store = new MemoryDeliveryClaimStore();
    const input = { userId: 'student', channel: 'push' as const, destinationId: 'device-a', releaseId: 'release-a', jobIds: ['job-b', 'job-a'] };
    const claim = store.claim(input, new Date('2026-08-23T12:00:00Z'))!;
    expect(store.claim(input, new Date('2026-08-23T12:00:01Z'))).toBeUndefined();
    expect(store.claim({ ...input, destinationId: 'device-b' }, new Date('2026-08-23T12:00:01Z'))).toBeDefined();
    store.transition(claim.claimId, 'unknown', new Date('2026-08-23T12:00:02Z'));
    expect(() => store.transition(claim.claimId, 'accepted', new Date('2026-08-23T12:00:03Z'))).toThrow(/Invalid delivery transition/);
    expect(logicalTombstoneId('student', 'push', 'release-a', ['job-a', 'job-b'])).toBe(claim.tombstoneId);
  });

  it('truncates individual titles on a natural boundary', () => {
    expect(naturalTruncate('A very long official software engineering internship title', 30)).toBe('A very long official…');
  });
});
