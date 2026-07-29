import { describe, expect, it } from 'vitest';
import { processSnapshot } from '../src/ingestion/processor.js';
import type { SourcedPosting } from '../src/types.js';

const posting = (overrides: Partial<SourcedPosting> = {}): SourcedPosting => ({
  sourceId: 'lever-acme',
  externalId: 'role-1',
  sourceUrl: 'https://api.lever.co/v0/postings/acme',
  fetchedAt: '2026-07-29T12:00:00.000Z',
  employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
  title: 'Software Engineering Intern, Summer 2027',
  content: [{ kind: 'description', format: 'html', value: '<p>Pays $50/hour &amp; requires a U.S. citizen.</p>' }],
  locations: ['New York, NY (Hybrid)'],
  applyUrl: 'https://jobs.lever.co/acme/role-1/apply',
  sourceState: 'open',
  ...overrides,
});

describe('shared posting processor', () => {
  it('normalizes content and emits a reason-coded included decision', () => {
    const result = processSnapshot({
      sourceId: 'lever-acme', outcome: 'changed', complete: true, postings: [posting()],
      rawCount: 1, contentHash: 'hash', checkpoint: { sourceId: 'lever-acme', successfulFetches: 1 },
    });
    expect(result.counts).toEqual({ raw: 1, valid: 1, eligible: 1, filtered: 0, withheld: 0 });
    expect(result.decisions).toEqual([{ externalId: 'role-1', outcome: 'included', reason: 'source-policy' }]);
    expect(result.listings[0]).toMatchObject({
      externalId: 'role-1', company: 'Acme', workMode: 'hybrid', season: 'summer-2027',
      compensation: { maxHourlyUSD: 50 },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      technical: true,
    });
  });

  it('keeps a reviewed early-career document as the lifecycle authority', () => {
    const result = processSnapshot({
      sourceId: 'markdown-list', outcome: 'changed', complete: true, rawCount: 2, contentHash: 'hash',
      checkpoint: { sourceId: 'markdown-list', successfulFetches: 1 },
      postings: [
        posting({ externalId: 'new-grad', title: 'Software Engineer, New Grad', lifecycleAuthority: 'source', content: [] }),
        posting({ externalId: 'recruiter', title: 'Campus Recruiter', lifecycleAuthority: 'source', content: [] }),
      ],
    });
    expect(result.decisions).toEqual([
      { externalId: 'new-grad', outcome: 'included', reason: 'source-policy' },
      { externalId: 'recruiter', outcome: 'filtered', reason: 'nontechnical' },
    ]);
    expect(result.listings.map((listing) => listing.title)).toEqual(['Software Engineer, New Grad']);
  });

  it('reports prospect, lifecycle, technical, invalid URL, and aggregator decisions', () => {
    const postings = [
      posting({ externalId: 'prospect', sourceState: 'prospect' }),
      posting({ externalId: 'senior', title: 'Senior Software Engineer' }),
      posting({ externalId: 'marketing', title: 'Marketing Intern' }),
      posting({ externalId: 'http', applyUrl: 'http://careers.example.test/role' }),
      posting({ externalId: 'aggregator', applyUrl: 'https://linkedin.com/jobs/role' }),
    ];
    const result = processSnapshot({
      sourceId: 'lever-acme', outcome: 'changed', complete: true, postings, rawCount: 5,
      contentHash: 'hash', checkpoint: { sourceId: 'lever-acme', successfulFetches: 1 },
    });
    expect(result.decisions.map(({ externalId, outcome, reason }) => ({ externalId, outcome, reason }))).toEqual([
      { externalId: 'prospect', outcome: 'filtered', reason: 'prospect' },
      { externalId: 'senior', outcome: 'filtered', reason: 'not-early-career' },
      { externalId: 'marketing', outcome: 'filtered', reason: 'nontechnical' },
      { externalId: 'http', outcome: 'withheld', reason: 'invalid-application-url' },
      { externalId: 'aggregator', outcome: 'withheld', reason: 'aggregator-destination' },
    ]);
  });
});
