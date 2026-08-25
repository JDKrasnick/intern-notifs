import { describe, expect, it } from 'vitest';
import { MemoryInternshipStore } from '../src/store.js';
import { Poller } from '../src/poll.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing = (url: string, sourceId = 'one'): RawListing => ({ sourceId, document: 'README.md', sourceUrl: 'https://github.com/x', row: 5, company: 'Acme', title: 'Software Engineering Intern', location: 'NYC', season: 'summer-2027', applyUrl: url, compensation: { raw: '$40/hr', maxHourlyUSD: 40 }, state: 'open', fetchedAt: '2026-01-01T00:00:00Z' });
class Adapter implements SourceAdapter {
  constructor(readonly id: string, private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } }; }
}
describe('polling', () => {
  it('persists successful not-modified checkpoints for source-health visibility', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'unchanged', successfulFetches: 1, lastRowCount: 3 });
    const adapter: SourceAdapter = {
      id: 'unchanged',
      async fetch(previous) {
        return {
          sourceId: 'unchanged',
          listings: [],
          notModified: true,
          checkpoint: { ...previous!, sourceId: 'unchanged', successfulFetches: 1, lastSuccessAt: '2026-07-29T12:00:00.000Z' },
        };
      },
    };
    const report = await new Poller([adapter], store).poll();
    expect(report.unchangedSources).toEqual(['unchanged']);
    expect(await store.getCheckpoint('unchanged')).toMatchObject({ lastSuccessAt: '2026-07-29T12:00:00.000Z' });
  });
  it('quietly seeds a source, then alerts a new canonical listing', async () => {
    const store = new MemoryInternshipStore();
    expect((await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll()).newJobs).toHaveLength(0);
    const second = await new Poller([new Adapter('one', [listing('https://jobs.example.com/a'), { ...listing('https://jobs.example.com/b'), title: 'Systems Engineering Intern' }])], store).poll();
    expect(second.newJobs).toHaveLength(1); expect(await store.pendingSms()).toHaveLength(1);
    expect([...store.jobs.values()].find((job) => job.title === 'Software Engineering Intern')).toMatchObject({ catalogRecency: 'baseline' });
    expect([...store.jobs.values()].find((job) => job.title === 'Systems Engineering Intern')).toMatchObject({ catalogRecency: 'normal' });
  });
  it('keeps a large quiet baseline behind a later normal role and out of new-since results', async () => {
    const store = new MemoryInternshipStore();
    const baseline = Array.from({ length: 60 }, (_, index) => ({
      ...listing(`https://jobs.example.com/baseline-${index}`), title: `Software Engineering Intern ${index}`,
    }));
    await new Poller([new Adapter('one', baseline)], store, () => new Date('2026-08-09T12:00:00.000Z')).poll();
    const fresh = { ...listing('https://jobs.example.com/fresh'), title: 'Platform Engineering Intern' };
    const report = await new Poller([new Adapter('one', [...baseline, fresh])], store, () => new Date('2026-08-10T12:00:00.000Z')).poll();
    expect(report.newJobs).toMatchObject([{ title: 'Platform Engineering Intern', catalogRecency: 'normal' }]);
    expect((await store.listOpen!(undefined, 25)).jobs[0]).toMatchObject({ title: 'Platform Engineering Intern' });
    expect(await store.listOpenSince('2026-08-08T00:00:00.000Z', '2026-08-11T00:00:00.000Z')).toMatchObject([{ title: 'Platform Engineering Intern' }]);
    expect(store.notificationEvents.size).toBe(1);
  });
  it('preserves normal catalog recency when a provider baseline attaches to a community role', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'community', successfulFetches: 1, lastRowCount: 0 });
    await new Poller([new Adapter('community', [listing('https://jobs.example.com/shared', 'community')])], store, () => new Date('2026-08-08T12:00:00.000Z')).poll();
    await new Poller([new Adapter('ashby-provider', [listing('https://jobs.example.com/shared?utm_source=ashby', 'ashby-provider')])], store, () => new Date('2026-08-09T12:00:00.000Z')).poll();
    const shared = [...store.jobs.values()][0]!;
    expect(shared).toMatchObject({ firstSeenAt: '2026-08-08T12:00:00.000Z', catalogVisibleAt: '2026-08-08T12:00:00.000Z', catalogRecency: 'normal' });
    expect(shared.sourceReferences[1]).toMatchObject({ sourceId: 'ashby-provider', firstAttachedAt: '2026-08-09T12:00:00.000Z', firstAttachedAtPrecision: 'exact' });
  });
  it('merges cross-source duplicates without alerting during baseline', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://jobs.example.com/a?utm_source=two', 'two')])], store).poll();
    expect(store.jobs.size).toBe(1); expect([...store.jobs.values()][0].sourceReferences).toHaveLength(2);
  });
  it('keeps evidence-poor roles separate when their apply URLs differ', async () => {
    const store = new MemoryInternshipStore(); await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://careers.example.net/a', 'two')])], store).poll();
    expect(store.jobs.size).toBe(2);
  });
  it('keeps distinct provider requisitions even when every display field matches', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://job-boards.greenhouse.io/acme/jobs/100')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://job-boards.greenhouse.io/acme/jobs/101', 'two')])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.providerPostingId).sort()).toEqual(['100', '101']);
  });
  it('converges reviewed URL variants on one provider posting identity', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://boards.greenhouse.io/acme?gh_jid=100')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://job-boards.greenhouse.io/acme/jobs/100', 'two')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'acme', providerPostingId: '100' },
      sourceReferences: [{ sourceId: 'one' }, { sourceId: 'two' }],
    });
  });
  it('persists TikTok source aliases as their canonical job URL', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://lifeattiktok.com/position/7623166667125508357')])], store).poll();
    const job = [...store.jobs.values()][0];
    expect(job.applyUrl).toBe('https://lifeattiktok.com/search/7623166667125508357');
    expect(job.sourceReferences[0].applyUrl).toBe(job.applyUrl);
  });
  it('retains a checkpoint when an established adapter suddenly returns zero rows', async () => {
    const store = new MemoryInternshipStore(); const initial = new Adapter('one', [listing('https://jobs.example.com/a')]); await new Poller([initial], store).poll();
    const report = await new Poller([new Adapter('one', [])], store).poll();
    expect(report.failures[0]).toContain('suspicious zero-row'); expect((await store.getCheckpoint('one'))?.lastRowCount).toBe(1);
  });
  it('stores closed technical roles without queuing alerts', async () => {
    const store = new MemoryInternshipStore();
    const closed = { ...listing('https://jobs.example.com/closed'), state: 'closed' as const };
    await new Poller([new Adapter('one', [closed])], store).poll();
    expect((await store.listOpen?.(undefined, 25, 'closed'))?.jobs).toMatchObject([{ open: false }]);
    expect(await store.pendingSms()).toEqual([]);
  });
  it('does not store or alert a role whose application link fails validation', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 1 });
    const report = await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/b')])],
      store,
      undefined,
      undefined,
      async () => { throw new Error('Application link returned HTTP 404'); },
    ).poll();
    expect(report.failures).toEqual([expect.stringContaining('row 5: Application link returned HTTP 404')]);
    expect(store.jobs.size).toBe(0);
    expect(report.newJobs).toEqual([]);
  });
  it('keeps a generic career shell in the catalog without alerting', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 1 });
    const report = await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/generic')])],
      store,
      undefined,
      undefined,
      async () => ({
        url: 'https://jobs.example.com/generic',
        evidence: { url: 'https://jobs.example.com/generic', title: 'Candidate Experience page', confidence: { score: 75, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['destination reached'] } },
      }),
    ).poll();
    expect(report.newJobs).toEqual([]);
    expect(report.filteredJobs).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({ notification: { smsPending: false, digestPending: false } });
  });
  const legacyOpenRole = async (store: MemoryInternshipStore) => {
    const role = listing('https://jobs.example.com/b');
    await store.putInternship({
      jobId: 'legacy-role', company: role.company, title: role.title, location: role.location,
      season: role.season, applyUrl: role.applyUrl, normalizedUrl: role.applyUrl, fingerprint: 'legacy-role',
      compensation: role.compensation, sourceReferences: [role], open: true, firstSeenAt: role.fetchedAt,
      lastSeenAt: role.fetchedAt, notification: { smsPending: true, digestPending: true },
    });
    return role;
  };

  it('quarantines a legacy open role when its source has not changed but its link is gone', async () => {
    const store = new MemoryInternshipStore();
    const role = await legacyOpenRole(store);
    const report = await new Poller(
      [new Adapter('one', [])], store, undefined, undefined,
      async () => { throw new Error('Application link returned HTTP 410'); },
    ).poll();
    expect((await store.getJob('legacy-role'))).toMatchObject({ open: false, invalidApplicationUrl: role.applyUrl, notification: { smsPending: false, digestPending: false } });
    expect(report.failures).toContain('catalog: legacy-role: Application link returned HTTP 410');
  });

  it('leaves a legacy open role alone when the employer only refuses to be read', async () => {
    const store = new MemoryInternshipStore();
    await legacyOpenRole(store);
    // Tesla and Citadel answer automated clients with 403. That proves nothing
    // about the posting, so hiding the role would lose a real job.
    const report = await new Poller(
      [new Adapter('one', [])], store, undefined, undefined,
      async () => { throw new Error('Application link returned HTTP 403'); },
    ).poll();
    const preserved = await store.getJob('legacy-role');
    expect(preserved?.open).toBe(true);
    expect(preserved?.invalidApplicationUrl).toBeUndefined();
    expect(report.failures).toContain('catalog: legacy-role: Application link returned HTTP 403');
  });

  it('lets per-source workers validate incoming listings without applying their host policy to the catalog', async () => {
    const store = new MemoryInternshipStore();
    await legacyOpenRole(store);
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 0 });
    const validated: string[] = [];
    const incoming = listing('https://jobs.example.com/incoming');
    const report = await new Poller(
      [new Adapter('one', [incoming])], store, undefined, undefined,
      async (url) => {
        validated.push(url);
        return { url, evidence: { url, confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['source policy'] } } };
      },
      false,
    ).poll();
    expect(report.failures).toEqual([]);
    expect(validated).toEqual([incoming.applyUrl]);
    expect((await store.getJob('legacy-role'))?.open).toBe(true);
  });
});
