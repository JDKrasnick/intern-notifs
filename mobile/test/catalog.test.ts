import { describe, expect, it } from 'vitest';
import { appendCatalogPage, catalogCardKind } from '../src/catalog.js';

describe('mobile catalog pagination', () => {
  it('appends later pages in order without duplicating a refreshed role', () => {
    const jobs = appendCatalogPage(
      [{ jobId: 'newest' }, { jobId: 'already-loaded' }],
      { jobs: [{ jobId: 'already-loaded' }, { jobId: 'machine-learning' }], cursor: 'next-page' },
    );

    expect(jobs.map((job) => job.jobId)).toEqual(['newest', 'already-loaded', 'machine-learning']);
  });

  it('renders any group filtered down to one role as the original role card', () => {
    expect(catalogCardKind({ roleCount: 1, featuredRole: { jobId: 'only-match' } })).toBe('role');
    expect(catalogCardKind({ roleCount: 2, featuredRole: { jobId: 'newest' } })).toBe('group');
  });
});
