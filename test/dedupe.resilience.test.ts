import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/core/normalize.js';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { Internship, RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing = (overrides: Partial<RawListing> = {}): RawListing => ({
  sourceId: 'source-a', document: 'README.md', sourceUrl: 'https://github.com/example/list', row: 1,
  company: 'Acme, Inc.', title: 'Software Engineering Internship', location: 'New York, NY', season: 'Summer-2027',
  applyUrl: 'https://careers.example.test/jobs/123?utm_source=list', compensation: { raw: '$50/hr', maxHourlyUSD: 50 },
  state: 'open', fetchedAt: '2026-07-19T12:00:00.000Z', ...overrides,
});
class Adapter implements SourceAdapter {
  constructor(readonly id: string, private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } };
  }
}

describe('dedupe resilience experiment', () => {
  it('merges common public-list variants into one canonical job and one alert', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('source-a', [listing()])], store).poll();
    const variants = [
      listing({ sourceId: 'source-b', document: 'OFFSEASON.md', row: 4, company: 'Acme Incorporated', title: 'Software Engineer Intern', location: 'NYC', season: 'summer 2027', applyUrl: 'https://boards.example.test/acme/123' }),
      listing({ sourceId: 'source-c', document: 'roles.md', row: 9, company: 'ACME INC', title: 'SWE Intern', location: 'New York City', season: 'SUMMER 2027', applyUrl: 'https://careers.example.test/jobs/123?utm_campaign=mail' }),
    ];
    const report = await new Poller([new Adapter('source-b', [variants[0]]), new Adapter('source-c', [variants[1]])], store).poll();
    expect(report.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.sourceReferences).toHaveLength(3);
    expect(await store.pendingSms()).toEqual([]);
  });

  it('does not over-merge roles that differ by employer or location', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('source-a', [listing()])], store).poll();
    await store.putCheckpoint({ sourceId: 'source-b', successfulFetches: 1, lastRowCount: 1 });
    const report = await new Poller([new Adapter('source-b', [
      listing({ sourceId: 'source-b', row: 2, company: 'Acme Capital', applyUrl: 'https://jobs.example.test/acme-capital/123' }),
      listing({ sourceId: 'source-b', row: 3, location: 'Austin, TX', applyUrl: 'https://jobs.example.test/acme/456' }),
    ])], store).poll();
    expect(store.jobs.size).toBe(3);
    expect(report.newJobs).toHaveLength(2);
  });

  it('never replaces a precise location with a duplicate source’s generic placeholder', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('source-a', [listing({ location: 'New York, NY' })])], store).poll();
    await store.putCheckpoint({ sourceId: 'source-b', successfulFetches: 1, lastRowCount: 1 });
    await new Poller([new Adapter('source-b', [listing({ sourceId: 'source-b', location: 'Unspecified' })])], store).poll();
    expect([...store.jobs.values()][0]?.location).toBe('New York, NY');
  });

  it('continues ingesting valid rows and preserves a checkpoint when one listing has a malformed apply URL', async () => {
    const store = new MemoryInternshipStore(); await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 1 });
    const report = await new Poller([new Adapter('source-a', [listing({ row: 2, applyUrl: 'not a URL' }), listing({ row: 3, title: 'Backend Software Intern', applyUrl: 'https://careers.example.test/jobs/456' })])], store).poll();
    expect(report.failures).toEqual([expect.stringContaining('row 2')]);
    expect(report.newJobs).toHaveLength(1);
    expect((await store.getCheckpoint('source-a'))?.successfulFetches).toBe(2);
  });

  it('recognizes pre-canonical records by their legacy fingerprint during a gradual deployment', async () => {
    const original = listing(); const legacy = createHash('sha256').update([original.company, original.title, original.location, original.season].map((value) => value.trim().toLowerCase().replace(/\s+/g, ' ')).join('|')).digest('hex');
    const existing: Internship = {
      jobId: 'legacy-job', company: original.company, title: original.title, location: original.location, season: original.season, applyUrl: original.applyUrl,
      normalizedUrl: 'https://obsolete.example.test/jobs/123', fingerprint: legacy, compensation: original.compensation, sourceReferences: [], open: true,
      firstSeenAt: original.fetchedAt, lastSeenAt: original.fetchedAt, notification: { smsPending: false, digestPending: false },
    };
    const store = new MemoryInternshipStore(); await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 1 }); await store.putInternship(existing);
    const report = await new Poller([new Adapter('source-b', [listing({ sourceId: 'source-b', applyUrl: 'https://boards.example.test/acme/123' })])], store).poll();
    expect(report.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(1);
    expect(fingerprint(original.company, original.title, original.location, original.season)).not.toBe(legacy);
    expect([...store.jobs.values()][0]?.fingerprint).toBe(fingerprint(original.company, original.title, original.location, original.season));
    await store.putCheckpoint({ sourceId: 'source-c', successfulFetches: 1, lastRowCount: 1 });
    const variant = await new Poller([new Adapter('source-c', [listing({ sourceId: 'source-c', company: 'Acme Incorporated', title: 'Software Engineer Intern', location: 'NYC', season: 'summer 2027', applyUrl: 'https://jobs.example.test/acme/123' })])], store).poll();
    expect(variant.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(1);
  });
});
