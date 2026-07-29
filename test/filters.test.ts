import { describe, expect, it } from 'vitest';
import { inferJobFocuses, isTechnicalJob, matchesJobFilter, parseJobFilter } from '../src/core/filters.js';
import { employerCategory } from '../src/core/employers.js';
import { MemoryInternshipStore } from '../src/store.js';
import { Poller } from '../src/poll.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing = (title: string, url: string, company = 'Example'): RawListing => ({ sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://example.com', row: 1, company, title, location: 'Remote', season: 'summer-2027', applyUrl: url, compensation: { raw: '' }, state: 'open', fetchedAt: '2026-07-19T00:00:00Z' });
class Adapter implements SourceAdapter {
  readonly id = 'fixture';
  constructor(private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } }; }
}

describe('job filters', () => {
  it('omits unset optional fields so a saved filter is DynamoDB-serializable', () => {
    expect(parseJobFilter({ includeCategories: ['swe'] })).toStrictEqual({
      includeCategories: ['swe']
    });
  });
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
  it('classifies FAANG and reviewed YC startups while keeping every other employer normal', () => {
    expect(employerCategory('Google LLC')).toBe('faang');
    expect(employerCategory('Vercel, Inc.')).toBe('startup');
    expect(employerCategory('Example Manufacturing')).toBe('normal');
  });
  it('uses employer categories in the same include/exclude filter path as GitHub-sourced listings', () => {
    const filter = parseJobFilter({ includeCategories: ['swe'], includeEmployerCategories: ['faang', 'startup'] });
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/google', 'Google'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/vercel', 'Vercel'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/normal', 'Example'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Product Intern', 'https://example.com/google-product', 'Google'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/excluded', 'Google'), parseJobFilter({ excludeEmployerCategories: ['faang'] }))).toBe(false);
    expect(() => parseJobFilter({ includeEmployerCategories: ['selective'] })).toThrow('unsupported employer category');
  });
  it('filters explicit U.S.-citizenship and advanced-degree requirements without adding a sponsorship filter', () => {
    const citizenship = { ...listing('Software Engineering Intern', 'https://example.com/citizenship'), requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false } };
    const advancedDegree = { ...listing('Research Intern', 'https://example.com/degree'), requirements: { requiresUsCitizenship: false, advancedDegreeRequired: true } };
    const filter = parseJobFilter({ excludeUsCitizenshipRequired: true, excludeAdvancedDegreeRequired: true });
    expect(matchesJobFilter(citizenship, filter)).toBe(false);
    expect(matchesJobFilter(advancedDegree, filter)).toBe(false);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/eligible'), filter)).toBe(true);
    expect(() => parseJobFilter({ excludeUsCitizenshipRequired: 'yes' })).toThrow('must be a boolean');
  });
  it('derives specific focus labels from role keywords without an LLM', () => {
    expect(inferJobFocuses(listing('Cloud Infrastructure Software Engineering Intern', 'https://example.com/cloud'))).toEqual(['Cloud/Infra']);
    expect(inferJobFocuses(listing('Machine Learning Platform Intern', 'https://example.com/ml'))).toEqual(['AI/ML', 'Cloud/Infra']);
    expect(inferJobFocuses(listing('Backend API Intern', 'https://example.com/backend'))).toEqual(['Backend/API']);
    expect(inferJobFocuses(listing('Software Engineering Intern', 'https://example.com/swe'))).toEqual(['SWE']);
  });
  it('keeps the initial catalog technical while retaining graduate filters as a preference', () => {
    expect(isTechnicalJob(listing('Software Engineering Intern', 'https://example.com/swe'))).toBe(true);
    expect(isTechnicalJob(listing('Human Resources Intern', 'https://example.com/hr'))).toBe(false);
  });
  it('stores filtered jobs but never queues them for push or email', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter([listing('Software Engineering Intern', 'https://example.com/initial')])], store).poll();
    const report = await new Poller([new Adapter([listing('Software Engineering Intern', 'https://example.com/initial'), listing('Graduate Research Intern', 'https://example.com/grad')])], store, () => new Date(), { excludeCategories: ['grad'] }).poll();
    expect(report.newJobs).toEqual([]); expect(report.filteredJobs).toHaveLength(1); expect(await store.pendingSms()).toEqual([]); expect(await store.pendingDigest()).toEqual([]);
  });
});
