import { describe, expect, it } from 'vitest';
import { MemoryInternshipStore } from '../src/store.js';
import { Poller } from '../src/poll.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult, SourceSnapshot } from '../src/types.js';

const listing = (url: string, sourceId = 'one'): RawListing => ({ sourceId, document: 'README.md', sourceUrl: 'https://github.com/x', row: 5, company: 'Acme', title: 'Software Engineering Intern', location: 'NYC', season: 'summer-2027', applyUrl: url, compensation: { raw: '$40/hr', maxHourlyUSD: 40 }, state: 'open', fetchedAt: '2026-01-01T00:00:00Z' });
const greenhouseListing = (postingId: string, url: string): RawListing => ({
  ...listing(url, 'greenhouse-figma'), externalId: postingId, document: postingId,
  providerEvidence: { provider: 'greenhouse', tenant: 'figma', postingId, sourceId: 'greenhouse-figma', urls: [url] },
});
const reviewedListing = (input: { provider: 'greenhouse' | 'lever'; tenant: string; postingId: string; sourceId: string; url: string }): RawListing => ({
  ...listing(input.url, input.sourceId), externalId: input.postingId, document: input.postingId,
  providerEvidence: { provider: input.provider, tenant: input.tenant, postingId: input.postingId, sourceId: input.sourceId, urls: [input.url] },
});
class Adapter implements SourceAdapter {
  fetches = 0;
  constructor(readonly id: string, private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { this.fetches += 1; return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } }; }
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
  it('reuses unchanged source rows when another row changes the snapshot', async () => {
    const store = new MemoryInternshipStore();
    const firstSeen = '2026-08-09T12:00:00.000Z';
    const changedAt = '2026-08-10T12:00:00.000Z';
    const resolver = {
      async configurationVersion() { return 'configuration-v1'; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/a')])],
      store,
      () => new Date(firstSeen),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();
    await new Poller(
      [new Adapter('one', [
        { ...listing('https://jobs.example.com/a'), row: 50 },
        { ...listing('https://jobs.example.com/b'), title: 'Systems Engineering Intern' },
      ])],
      store,
      () => new Date(changedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();
    const unchanged = [...store.jobs.values()].find((job) => job.title === 'Software Engineering Intern');
    expect(unchanged).toMatchObject({ lastSeenAt: firstSeen, sourceReferences: [{ row: 5 }] });
    expect(await store.getCheckpoint('one')).toMatchObject({ activeExternalIds: expect.arrayContaining([
      'README.md:https://jobs.example.com/a', 'README.md:https://jobs.example.com/b',
    ]) });

    const updatedAt = '2026-08-11T12:00:00.000Z';
    await new Poller(
      [new Adapter('one', [
        { ...listing('https://jobs.example.com/a'), title: 'Platform Engineering Intern' },
        { ...listing('https://jobs.example.com/b'), title: 'Systems Engineering Intern' },
      ])],
      store,
      () => new Date(updatedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();
    expect([...store.jobs.values()].find((job) => job.applyUrl === 'https://jobs.example.com/a'))
      .toMatchObject({ lastSeenAt: updatedAt });
    expect((await store.getSourceOccurrences('one')).find((occurrence) => occurrence.externalId.endsWith('/a')))
      .toMatchObject({ occurrence: { title: 'Platform Engineering Intern' } });
  });
  it('resumes an interrupted admission configuration migration from per-row progress', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = (observedAt: string, row = 5) => new Poller(
      [new Adapter('one', [{ ...listing('https://jobs.example.com/a'), row }])],
      store,
      () => new Date(observedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();

    await run('2026-08-09T12:00:00.000Z');
    configurationVersion = 'configuration-v2';
    const migratedAt = '2026-08-10T12:00:00.000Z';
    await run(migratedAt);
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({
      occurrence: { admissionConfigurationVersion: 'configuration-v2' },
    });

    const migratedCheckpoint = await store.getCheckpoint('one');
    await store.putCheckpoint({ ...migratedCheckpoint!, admissionConfigurationVersion: 'configuration-v1' });
    await run('2026-08-11T12:00:00.000Z', 99);
    expect([...store.jobs.values()][0]).toMatchObject({ lastSeenAt: migratedAt });
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({ occurrence: { row: 5 } });
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
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
  it('keeps identity-unconfirmed same-URL occurrences source-local', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'community', successfulFetches: 1, lastRowCount: 0 });
    await new Poller([new Adapter('community', [listing('https://jobs.example.com/shared', 'community')])], store, () => new Date('2026-08-08T12:00:00.000Z')).poll();
    await new Poller([new Adapter('ashby-provider', [listing('https://jobs.example.com/shared?utm_source=ashby', 'ashby-provider')])], store, () => new Date('2026-08-09T12:00:00.000Z')).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ firstSeenAt: '2026-08-08T12:00:00.000Z', catalogRecency: 'normal', postingIdentityStatus: 'unconfirmed' }),
      expect.objectContaining({ firstSeenAt: '2026-08-09T12:00:00.000Z', postingIdentityStatus: 'unconfirmed' }),
    ]));
  });
  it('does not merge cross-source occurrences from normalized URL syntax alone', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://jobs.example.com/a?utm_source=two', 'two')])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].every((job) => job.postingIdentityStatus === 'unconfirmed')).toBe(true);
  });
  it('does not let an unverified community occurrence revive a closed canonical posting', async () => {
    const store = new MemoryInternshipStore();
    const url = 'https://copart.wd12.myworkdayjobs.com/Copart/job/Dallas-TX/Software-Engineering-Intern_JR101510';
    const variant = 'https://copart.wd12.myworkdayjobs.com/en-US/Copart/job/Dallas-TX/Software-Engineering-Intern_JR101510';
    await new Poller([new Adapter('one', [{ ...listing(url), state: 'closed' as const }])], store).poll();
    await new Poller([new Adapter('community', [listing(variant, 'community')])], store).poll();
    expect([...store.jobs.values()][0]).toMatchObject({
      open: false,
      sourceReferences: [{ sourceId: 'one' }, { sourceId: 'community', state: 'open' }],
    });
  });
  it('adopts a legacy tracked URL when canonical tracking cleanup changes its lookup key', async () => {
    const store = new MemoryInternshipStore();
    const tracked = 'https://jobs.example.com/a?gh_src=legacy&utm_source=list';
    const reference = listing(tracked);
    await store.putInternship({
      jobId: 'legacy-tracked', company: reference.company, title: reference.title, location: reference.location,
      season: reference.season, applyUrl: tracked, normalizedUrl: 'https://jobs.example.com/a?gh_src=legacy',
      fingerprint: 'legacy-tracked', compensation: reference.compensation, sourceReferences: [reference], open: true,
      firstSeenAt: reference.fetchedAt, lastSeenAt: reference.fetchedAt, notification: { smsPending: false, digestPending: false },
    });
    await new Poller([new Adapter('one', [listing(tracked)])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.jobId).toBe('legacy-tracked');
  });
  it('keeps evidence-poor roles separate when their apply URLs differ', async () => {
    const store = new MemoryInternshipStore(); await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://careers.example.net/a', 'two')])], store).poll();
    expect(store.jobs.size).toBe(2);
  });
  it('keeps distinct provider requisitions even when every display field matches', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('greenhouse-figma', [greenhouseListing('100', 'https://job-boards.greenhouse.io/figma/jobs/100')])], store).poll();
    await new Poller([new Adapter('greenhouse-figma', [greenhouseListing('101', 'https://job-boards.greenhouse.io/figma/jobs/101')])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.providerPostingId).sort()).toEqual(['100', '101']);
  });
  it('never bridges distinct confirmed IDs through a reused ordinary application URL', async () => {
    const store = new MemoryInternshipStore();
    const shared = 'https://careers.example.test/apply';
    await new Poller([new Adapter('greenhouse-acme', [reviewedListing({
      provider: 'greenhouse', tenant: 'acme', postingId: '100', sourceId: 'greenhouse-acme', url: shared,
    })])], store).poll();
    await new Poller([new Adapter('greenhouse-acme', [reviewedListing({
      provider: 'greenhouse', tenant: 'acme', postingId: '101', sourceId: 'greenhouse-acme', url: shared,
    })])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.providerPostingId).sort()).toEqual(['100', '101']);
    expect([...store.jobs.values()].every((job) => job.sourceReferences.length === 1)).toBe(true);
  });
  it('converges reviewed URL variants on one provider posting identity', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('greenhouse-figma', [greenhouseListing('100', 'https://boards.greenhouse.io/figma?gh_jid=100')])], store).poll();
    await new Poller([new Adapter('community', [listing('https://job-boards.greenhouse.io/figma/jobs/100', 'community')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'figma', providerPostingId: '100' },
      sourceReferences: [{ sourceId: 'greenhouse-figma' }, { sourceId: 'community' }],
    });
  });
  it.each([
    ['official first', true],
    ['community first', false],
  ])('converges a tenant-less Greenhouse embed when the %s occurrence arrives', async (_label, officialFirst) => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    const official = reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    });
    const community = listing(`https://boards.greenhouse.io/embed/job_app?token=${postingId}`, 'community');
    const polls = officialFirst
      ? [new Adapter('greenhouse-databricks', [official]), new Adapter('community', [community])]
      : [new Adapter('community', [community]), new Adapter('greenhouse-databricks', [official])];
    for (const adapter of polls) await new Poller([adapter], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'databricks', providerPostingId: postingId },
    });
    expect(new Set([...store.jobs.values()][0]!.sourceReferences.map(({ sourceId }) => sourceId)))
      .toEqual(new Set(['greenhouse-databricks', 'community']));
  });
  it('converges a community-first tenant-less embed against the current provider snapshot', async () => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    const official = new Adapter('greenhouse-databricks', [reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    })]);
    await new Poller([
      new Adapter('community', [listing(`https://boards.greenhouse.io/embed/job_app?token=${postingId}`, 'community')]),
      official,
    ], store).poll();
    expect(official.fetches).toBe(1);
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'databricks', providerPostingId: postingId },
      sourceReferences: [{ sourceId: 'community' }, { sourceId: 'greenhouse-databricks' }],
    });
  });
  it('does not scope a tenant-less Greenhouse embed when two active reviewed boards contain its ID', async () => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    await store.putCheckpoint({ sourceId: 'greenhouse-databricks', successfulFetches: 1, activeExternalIds: [postingId] });
    await store.putCheckpoint({ sourceId: 'greenhouse-figma', successfulFetches: 1, activeExternalIds: [postingId] });
    await new Poller([new Adapter('community', [listing(`https://boards.greenhouse.io/embed/job_app?token=${postingId}`, 'community')])], store).poll();
    await new Poller([new Adapter('greenhouse-databricks', [reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    })])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.provider).sort()).toEqual(['greenhouse', undefined]);
    expect([...store.jobs.values()].find((job) => !job.postingIdentity)).toMatchObject({ postingIdentityStatus: 'unconfirmed' });
  });
  it('keeps a fresh tenant-less embed separate when two current reviewed snapshots share its ID', async () => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    const embedUrl = `https://boards.greenhouse.io/embed/job_app?token=${postingId}`;
    const databricks = new Adapter('greenhouse-databricks', [reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    })]);
    const figma = new Adapter('greenhouse-figma', [reviewedListing({
      provider: 'greenhouse', tenant: 'figma', postingId, sourceId: 'greenhouse-figma',
      url: `https://job-boards.greenhouse.io/figma/jobs/${postingId}`,
    })]);
    await new Poller([
      new Adapter('community', [listing(embedUrl, 'community')]),
      databricks,
      figma,
    ], store).poll();
    expect([databricks.fetches, figma.fetches]).toEqual([1, 1]);
    expect(store.jobs.size).toBe(3);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.tenant ?? 'unscoped').sort())
      .toEqual(['databricks', 'figma', 'unscoped']);
    expect([...store.jobs.values()].map((job) => job.sourceReferences.map(({ sourceId }) => sourceId)))
      .toEqual([['community'], ['greenhouse-databricks'], ['greenhouse-figma']]);
  });
  it('converges historical DRW custom and standard routes only after the active public ID confirms them', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('greenhouse-drweng', [reviewedListing({ provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng', url: 'https://job-boards.greenhouse.io/drweng/jobs/3413670' })])], store).poll();
    await new Poller([new Adapter('community', [listing('https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?utm_source=community', 'community')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({ postingIdentity: { tenant: 'drweng', providerPostingId: '3413670' }, sourceReferences: [{ sourceId: 'greenhouse-drweng' }, { sourceId: 'community' }] });
  });
  it('converges the historical PlusAI Lever hosted/apply pair', async () => {
    const store = new MemoryInternshipStore(); const id = 'b4f750e7-0148-41f0-b2b1-ff054450a320';
    await new Poller([new Adapter('lever-plusai', [reviewedListing({ provider: 'lever', tenant: 'plus-2', postingId: id, sourceId: 'lever-plusai', url: `https://jobs.lever.co/plus-2/${id}/apply` })])], store).poll();
    await new Poller([new Adapter('community', [listing(`https://jobs.lever.co/plus-2/${id}?ref=community`, 'community')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.postingIdentity).toMatchObject({ provider: 'lever', tenant: 'plus-2', providerPostingId: id });
  });
  it('does not infer a provider identity for an inactive custom-host public ID', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'greenhouse-drweng', successfulFetches: 1, activeExternalIds: ['3413670'] });
    await new Poller([new Adapter('community', [listing('https://www.drw.com/work-at-drw/listings/software-developer-intern-9999999', 'community')])], store).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ postingIdentityStatus: 'unconfirmed' });
    expect([...store.jobs.values()][0]?.postingIdentity).toBeUndefined();
  });
  it('uses a reviewed custom-host ID for identity without treating a generic destination as alert eligible', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'greenhouse-drweng', successfulFetches: 1, activeExternalIds: ['3413670'], lastRowCount: 1 });
    const generic = reviewedListing({
      provider: 'greenhouse',
      tenant: 'drweng',
      postingId: '3413670',
      sourceId: 'greenhouse-drweng',
      url: 'https://www.drw.com/open-roles?gh_jid=3413670',
    });
    const inspected: string[] = [];
    const report = await new Poller(
      [new Adapter('greenhouse-drweng', [generic])],
      store,
      undefined,
      undefined,
      async (url) => {
        inspected.push(url);
        return {
          url,
          evidence: {
            url,
            title: 'Open roles',
            confidence: { score: 50, level: 'medium', recommendation: 'catalog-only', signals: ['destination reached'] },
          },
        };
      },
    ).poll();
    expect(inspected).not.toHaveLength(0);
    expect(new Set(inspected)).toEqual(new Set([generic.applyUrl]));
    expect(report.newJobs).toEqual([]);
    expect(report.filteredJobs).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      company: 'Acme',
      postingIdentity: { provider: 'greenhouse', tenant: 'drweng', providerPostingId: '3413670' },
      notification: { smsPending: false, digestPending: false },
    });
  });
  it('quarantines direct provider evidence whose reviewed route points at another board', async () => {
    const store = new MemoryInternshipStore();
    const mismatched = reviewedListing({ provider: 'greenhouse', tenant: 'figma', postingId: '123', sourceId: 'greenhouse-figma', url: 'https://job-boards.greenhouse.io/spacex/jobs/123' });
    const report = await new Poller([new Adapter('greenhouse-figma', [mismatched])], store).poll();
    expect(store.jobs.size).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.quarantinedListings).toEqual([expect.objectContaining({
      sourceId: 'greenhouse-figma',
      row: 5,
      reason: expect.stringContaining('provider-scope-mismatch'),
    })]);
    expect(await store.getCheckpoint('greenhouse-figma')).toMatchObject({ successfulFetches: 1 });
  });
  it('persists TikTok source aliases as their canonical job URL', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://lifeattiktok.com/position/7623166667125508357')])], store).poll();
    const job = [...store.jobs.values()][0];
    expect(job.applyUrl).toBe('https://lifeattiktok.com/search/7623166667125508357');
    expect(job.sourceReferences[0].applyUrl).toBe(job.applyUrl);
  });
  it.each([
    [
      'Workday',
      'https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_JR108448',
      'https://micron.wd5.myworkdayjobs.com/en-US/External/job/Intern_JR108448',
    ],
    [
      'ByteDance',
      'https://lifeattiktok.com/search/7672883129493948677',
      'https://jobs.bytedance.com/en/position/7672883129493948677/detail',
    ],
  ])('converges exact %s provider routes during ingestion', async (_provider, first, second) => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing(first)])], store).poll();
    await new Poller([new Adapter('two', [listing(second, 'two')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.sourceReferences.map((reference) => reference.sourceId)).toEqual(['one', 'two']);
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

  it('applies reviewed employer mappings and destination rules during neutral ingestion', async () => {
    const store = new MemoryInternshipStore();
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'greenhouse-board-label', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'hash',
      listings: [], notModified: false,
      checkpoint: { sourceId: 'greenhouse-board-label', successfulFetches: 1 },
      postings: [{
        sourceId: 'greenhouse-board-label', provenance: 'official-ats', externalId: '123', sourceUrl: 'https://boards-api.greenhouse.io/board-label',
        fetchedAt: '2026-08-27T12:00:00Z', employer: { id: 'board-label', name: 'Talent Community', authority: 'reviewed-registry' },
        providerIdentity: { provider: 'greenhouse', tenant: 'board-label' }, title: 'Software Engineering Intern',
        content: [], locations: ['Remote'], applyUrl: 'https://careers.example.test/roles/123', sourceState: 'open',
      }],
    };
    const adapter: SourceAdapter = { id: snapshot.sourceId, async fetch() { return snapshot; } };
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
      async resolveDestinationRule() { return { id: 'reviewed-custom-route', host: 'careers.example.test', provider: 'greenhouse' as const,
        tenant: 'board-label', decision: 'standard-provider-route' as const, reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' }; },
    };
    await new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Acme', admission: {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, catalogEligible: true,
    } });
  });

  it('preserves legacy community rows while withholding new unmapped employers', async () => {
    const store = new MemoryInternshipStore();
    const legacy = await legacyOpenRole(store);
    const legacyJob = (await store.getJob('legacy-role'))!;
    const priorUrl = 'https://ancestry.wd501.myworkdayjobs.com/Careers/job/Remote/Software-Engineer---Observability--Co-op_R003434';
    const refreshedUrl = 'https://ancestry.wd501.myworkdayjobs.com/en-US/careers/job/Draper-Utah/Software-Engineer---Observability--Co-op_R003434';
    await store.putInternship({ ...legacyJob, applyUrl: priorUrl, normalizedUrl: priorUrl,
      sourceReferences: [{ ...legacyJob.sourceReferences[0]!, sourceId: 'community-list', externalId: 'acme-role', applyUrl: priorUrl }] });
    await store.claimPostingIdentity(buildPostingIdentity({ applicationUrl: priorUrl }), 'legacy-role');
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'community-list', outcome: 'changed', complete: true, rawCount: 2, contentHash: 'community-hash',
      listings: [], notModified: false,
      checkpoint: { sourceId: 'community-list', successfulFetches: 2 },
      postings: [
        { sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'acme-role', sourceUrl: 'https://github.com/example/jobs',
          fetchedAt: '2026-08-27T12:00:00Z', employer: { name: 'Acme', authority: 'source-row' }, title: legacy.title,
          content: [], locations: [legacy.location], applyUrl: refreshedUrl, sourceState: 'open', lifecycleAuthority: 'source' },
        { sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'beta-role', sourceUrl: 'https://github.com/example/jobs',
          fetchedAt: '2026-08-27T12:00:00Z', employer: { name: 'Beta', authority: 'source-row' }, title: 'Data Engineering Intern',
          content: [], locations: ['Remote'], applyUrl: 'https://jobs.example.com/beta', sourceState: 'open', lifecycleAuthority: 'source' },
      ],
    };
    const resolver = {
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store, undefined, undefined, undefined, undefined, undefined, resolver).poll();
    const preserved = await store.getJob('legacy-role');
    expect(preserved?.open).toBe(true);
    expect(preserved?.admission).toBeUndefined();
    expect(preserved?.sourceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'community-list', applyUrl: refreshedUrl }),
    ]));
    expect([...store.jobs.values()].find((job) => job.company === 'Beta')).toMatchObject({
      admission: { catalogEligible: false, alertEligible: false, reasonCodes: expect.arrayContaining(['employer-unresolved']) },
    });
  });

  it('queues an attributed-provider check when a reviewed community URL is specific but the posting is not yet corroborated', async () => {
    const store = new MemoryInternshipStore();
    const queued: Array<{ candidateUrl: string; providerIdentity: { provider: string; postingId?: string }; reason: string }> = [];
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'community-list', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'community-axon',
      listings: [], notModified: false, checkpoint: { sourceId: 'community-list', successfulFetches: 1 },
      postings: [{ sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1',
        sourceUrl: 'https://github.com/example/jobs', fetchedAt: '2026-08-28T00:00:00Z',
        employer: { name: 'Axon', authority: 'source-row' }, title: '2027 US Mechanical Engineering Internship',
        content: [], locations: ['Arizona, USA'], applyUrl: 'https://job-boards.greenhouse.io/axon/jobs/7978840003',
        sourceState: 'open', lifecycleAuthority: 'source' }],
    };
    const reviewed: { decision?: 'aggregate-board' } = {};
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'axon', displayName: 'Axon' }; },
      async resolveDestinationRule() {
        return reviewed.decision ? { id: 'axon-route', host: 'job-boards.greenhouse.io', provider: 'greenhouse' as const,
          tenant: 'axon', decision: reviewed.decision, reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' } : undefined;
      },
    };
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ admission: { catalogEligible: false,
      reasonCodes: ['posting-unattributed'], destination: { classification: 'posting-detail' } } });
    expect(queued).toMatchObject([{ candidateUrl: 'https://job-boards.greenhouse.io/axon/jobs/7978840003',
      providerIdentity: { provider: 'greenhouse', postingId: '7978840003' }, reason: 'first-sight' }]);

    const first = [...store.jobs.values()][0]!;
    const verified = {
      ...first.sourceReferences[0]!.admission!, postingAttribution: 'attributed' as const,
      destination: { ...first.sourceReferences[0]!.admission!.destination, browserVisible: true,
        inspectedAt: '2026-08-28T00:05:00Z' }, catalogEligible: true, alertEligible: true, reasonCodes: [],
    };
    await store.putInternship({ ...first, admission: verified,
      sourceReferences: [{ ...first.sourceReferences[0]!, admission: verified }] });
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll();
    expect(queued).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({ admission: { destination: { browserVisible: true } },
      sourceReferences: [{ admission: { destination: { browserVisible: true } } }] });

    const attributed = [...store.jobs.values()][0]!;
    const unattributed = { ...attributed.admission!, postingAttribution: 'unattributed' as const };
    await store.putInternship({ ...attributed, admission: unattributed,
      sourceReferences: [{ ...attributed.sourceReferences[0]!, admission: unattributed }] });
    reviewed.decision = 'aggregate-board';
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll();
    expect(queued).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({ admission: {
      catalogEligible: false, destination: { classification: 'aggregate-board' },
      reasonCodes: ['destination-aggregate-board', 'posting-unattributed'],
    } });
  });

  it('keeps an existing exact-URL community role visible while its posting attribution is queued', async () => {
    const store = new MemoryInternshipStore();
    const applyUrl = 'https://job-boards.greenhouse.io/axon/jobs/7978840003';
    const reference = { ...listing(applyUrl, 'community-list'), externalId: 'row-1', provenance: 'reviewed-community' as const,
      company: 'Axon', title: '2027 US Mechanical Engineering Internship', location: 'Arizona, USA' };
    await store.putInternship({ jobId: 'legacy-axon', company: reference.company, title: reference.title,
      location: reference.location, season: reference.season, applyUrl, normalizedUrl: applyUrl, fingerprint: 'legacy-axon',
      compensation: reference.compensation, sourceReferences: [reference], open: true, firstSeenAt: reference.fetchedAt,
      lastSeenAt: reference.fetchedAt, notification: { smsPending: false, digestPending: false } });
    await store.claimPostingIdentity(buildPostingIdentity({ applicationUrl: applyUrl }), 'legacy-axon');
    const queued: string[] = [];
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'community-list', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'community-axon-refresh',
      listings: [], notModified: false, checkpoint: { sourceId: 'community-list', successfulFetches: 2 },
      postings: [{ sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1',
        sourceUrl: reference.sourceUrl, fetchedAt: '2026-08-28T00:00:00Z', employer: { name: 'Axon', authority: 'source-row' },
        title: reference.title, content: [], locations: [reference.location], applyUrl, sourceState: 'open', lifecycleAuthority: 'source' }],
    };
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'axon', displayName: 'Axon' }; },
      async resolveDestinationRule() { return undefined; },
    };
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async ({ candidateUrl }) => { queued.push(candidateUrl); }, resolver).poll();
    const preserved = await store.getJob('legacy-axon');
    expect(preserved?.admission).toBeUndefined();
    expect(preserved).toMatchObject({ open: true, notification: { smsPending: false, digestPending: false } });
    expect(queued).toEqual([applyUrl]);
  });

  it('reprocesses an unchanged source after reviewed admission configuration changes', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'greenhouse-acme', successfulFetches: 1, contentHash: 'same', etag: 'old-etag',
      admissionConfigurationVersion: 'configuration-v1' });
    let received: SourceCheckpoint | undefined;
    const adapter: SourceAdapter = {
      id: 'greenhouse-acme',
      async fetch(previous) {
        received = previous;
        return {
          sourceId: 'greenhouse-acme', outcome: previous?.contentHash === 'same' ? 'unchanged' : 'changed', complete: true,
          rawCount: 1, contentHash: 'same', listings: [], notModified: previous?.contentHash === 'same',
          checkpoint: { sourceId: 'greenhouse-acme', successfulFetches: 2, contentHash: 'same' },
          postings: [{ sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: 'acme-role', sourceUrl: 'https://boards-api.greenhouse.io/acme',
            fetchedAt: '2026-08-27T12:00:00Z', employer: { name: 'Acme', authority: 'reviewed-registry' }, title: 'Software Engineering Intern',
            providerIdentity: { provider: 'greenhouse', tenant: 'acme' },
            content: [], locations: ['Remote'], applyUrl: 'https://jobs.example.com/acme-role', sourceState: 'open', lifecycleAuthority: 'source' }],
        };
      },
    };
    const resolver = {
      async configurationVersion() { return 'configuration-v2'; },
      async resolveCanonicalEmployer(identity: { employerScope?: string }) {
        return identity.employerScope === 'employer:acme' ? { id: 'acme', displayName: 'Acme' } : undefined;
      },
      async resolveDestinationRule() { return { id: 'custom-posting-route', host: 'jobs.example.com', provider: 'greenhouse' as const,
        decision: 'standard-provider-route' as const, reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' }; },
    };
    await new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver).poll();
    expect(received).toMatchObject({ contentHash: undefined, etag: undefined });
    expect(await store.getCheckpoint('greenhouse-acme')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Acme', admission: { catalogEligible: true } });
  });
});
