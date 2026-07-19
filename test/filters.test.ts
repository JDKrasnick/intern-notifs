import { describe, expect, it } from 'vitest';
import { matchesJobFilter, parseJobFilter } from '../src/core/filters.js';
import { MemoryInternshipStore } from '../src/store.js';
import { Poller } from '../src/poll.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing = (title: string, url: string): RawListing => ({ sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://example.com', row: 1, company: 'Example', title, location: 'Remote', season: 'summer-2027', applyUrl: url, compensation: { raw: '' }, state: 'open', fetchedAt: '2026-07-19T00:00:00Z' });
class Adapter implements SourceAdapter {
  readonly id = 'fixture';
  constructor(private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } }; }
}

describe('job filters', () => {
  it('excludes graduate jobs without excluding undergraduate internships', () => {
    const filter = parseJobFilter({ excludeCategories: ['grad'] });
    expect(matchesJobFilter(listing('Graduate Software Engineer Intern', 'https://example.com/grad'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Undergraduate Software Engineering Intern', 'https://example.com/undergrad'), filter)).toBe(true);
  });
  it('supports category and keyword inclusion with exclusions taking precedence', () => {
    const filter = parseJobFilter({ includeCategories: ['ai-ml'], includeKeywords: ['robotics'], excludeKeywords: ['senior'] });
    expect(matchesJobFilter(listing('Machine Learning Intern', 'https://example.com/ml'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Robotics Intern', 'https://example.com/robotics'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Senior Machine Learning Intern', 'https://example.com/senior'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Finance Intern', 'https://example.com/finance'), filter)).toBe(false);
    expect(() => parseJobFilter({ excludeCategories: ['not-a-category'] })).toThrow('unsupported category');
  });
  it('stores filtered jobs but never queues them for push or email', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter([listing('Software Engineering Intern', 'https://example.com/initial')])], store).poll();
    const report = await new Poller([new Adapter([listing('Software Engineering Intern', 'https://example.com/initial'), listing('Graduate Research Intern', 'https://example.com/grad')])], store, () => new Date(), { excludeCategories: ['grad'] }).poll();
    expect(report.newJobs).toEqual([]); expect(report.filteredJobs).toHaveLength(1); expect(await store.pendingSms()).toEqual([]); expect(await store.pendingDigest()).toEqual([]);
  });
});
