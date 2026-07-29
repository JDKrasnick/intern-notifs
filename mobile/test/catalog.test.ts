import { describe, expect, it } from 'vitest';
import { appendCatalogPage } from '../src/catalog.js';

describe('mobile catalog pagination', () => {
  it('appends later pages in order without duplicating a refreshed role', () => {
    const jobs = appendCatalogPage(
      [{ jobId: 'newest' }, { jobId: 'already-loaded' }],
      { jobs: [{ jobId: 'already-loaded' }, { jobId: 'machine-learning' }], cursor: 'next-page' },
    );

    expect(jobs.map((job) => job.jobId)).toEqual(['newest', 'already-loaded', 'machine-learning']);
  });
});
