import { describe, expect, it } from 'vitest';
import { isPastSeason } from '../src/core/early-career.js';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { canonicalRoleTitles, repairTitle, sameRole } from '../src/core/role-title.js';
import { processSnapshot } from '../src/ingestion/processor.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { Internship, SourcedPosting } from '../src/types.js';

const job = (overrides: Partial<Internship>): Internship => ({
  jobId: 'job-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote',
  season: 'summer-2027', applyUrl: 'https://careers.example.test/a', normalizedUrl: 'https://careers.example.test/a',
  fingerprint: 'fp-1', compensation: { raw: '' }, sourceReferences: [], open: true, technical: true,
  firstSeenAt: '2026-07-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z',
  notification: { smsPending: false, digestPending: false }, ...overrides,
});

const posting = (overrides: Partial<SourcedPosting>): SourcedPosting => ({
  sourceId: 'zapply', externalId: 'role-1', sourceUrl: 'https://x.test', fetchedAt: '2026-07-29T12:00:00.000Z',
  employer: { name: 'Acme', authority: 'source-row' }, title: 'Software Engineer Intern',
  content: [], locations: ['Remote'], applyUrl: 'https://careers.example.test/role-1',
  sourceState: 'open', seasonHint: 'summer-2027', ...overrides,
});

describe('application URL parsing', () => {
  it('never takes an application URL from a cell other than the role or apply column', () => {
    // SimplifyJobs links the company cell to an aggregator profile page. Treating
    // that as an application URL invented 1,469 unusable rows.
    const rows = parseInternshipMarkdown(
      '| Company | Role | Location | Apply |\n| --- | --- | --- | --- |\n'
      + '| <a href="https://simplify.jobs/c/Acme">Acme</a> | Software Engineer Intern | Remote | <div>see website</div> |',
      { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://github.test', season: 'summer-2027' },
    );
    expect(rows).toEqual([]);
  });

  it('still reads an application link published in the role cell', () => {
    const rows = parseInternshipMarkdown(
      '| Company | Role | Apply |\n| --- | --- | --- |\n'
      + '| Acme | [Software Engineer Intern](https://careers.example.test/acme) | |',
      { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://github.test', season: 'summer-2027' },
    );
    expect(rows.map((row) => row.applyUrl)).toEqual(['https://careers.example.test/acme']);
  });
});

describe('past hiring cycles', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');

  it('treats a cycle as past once its season has begun', () => {
    expect(isPastSeason('summer-2026', now)).toBe(true);
    expect(isPastSeason('spring-2026', now)).toBe(true);
    expect(isPastSeason('fall-2026', now)).toBe(false);
    expect(isPastSeason('summer-2027', now)).toBe(false);
  });

  it('expires undated seasons only once their year has passed', () => {
    expect(isPastSeason('offseason-2026', now)).toBe(false);
    expect(isPastSeason('offseason-2025', now)).toBe(true);
    expect(isPastSeason('ongoing', now)).toBe(false);
  });

  it('keeps a begun cycle out of the feed and the launch inbox', async () => {
    const store = new MemoryInternshipStore();
    await store.putInternship(job({ jobId: 'current', season: 'summer-2027' }));
    await store.putInternship(job({ jobId: 'past', season: 'summer-2020' }));
    expect((await store.listOpen()).jobs.map((value) => value.jobId)).toEqual(['current']);
    expect((await store.listOpenSince('2026-06-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'))
      .map((value) => value.jobId)).toEqual(['current']);
  });
});

describe('truncated role titles', () => {
  it('prefers a whole title the same employer already published', () => {
    expect(repairTitle('Software Engineer Intern (Recommendat...', ['Software Engineer Intern (Recommendation Systems)']))
      .toBe('Software Engineer Intern (Recommendation Systems)');
  });

  it('falls back to the longest canonical title the cut text begins with', () => {
    expect(repairTitle('Software Engineer Intern (Applied Mac...')).toBe('Software Engineer Intern');
    expect(repairTitle('Quantitative Research Intern - Equiti...')).toBe('Quantitative Research Intern');
  });

  it('drops the dangling partial word when nothing matches', () => {
    expect(repairTitle('Powertrain Controls Software Engineer...')).toBe('Powertrain Controls Software');
    // "SRE Project Intern" is a real role but not a canonical title, so it is
    // trimmed rather than snapped onto a title the employer never posted.
    expect(repairTitle('Site Reliability Engineer Project Int...')).toBe('Site Reliability Engineer Project');
  });

  it('leaves a whole title untouched', () => {
    for (const title of [...canonicalRoleTitles.slice(0, 5), 'Deployment Strategist, Internship']) {
      expect(repairTitle(title), title).toBe(title);
    }
  });

  it('repairs from the employer snapshot and marks the title approximate', () => {
    const result = processSnapshot({
      sourceId: 'zapply', outcome: 'changed', complete: true, rawCount: 2, contentHash: 'hash',
      checkpoint: { sourceId: 'zapply', successfulFetches: 1 },
      postings: [
        posting({ externalId: 'whole', title: 'Software Engineer Intern (Compilers)' }),
        posting({ externalId: 'cut', title: 'Software Engineer Intern (Compi...' }),
      ],
    });
    expect(result.listings.map((listing) => [listing.title, listing.titleRepaired])).toEqual([
      ['Software Engineer Intern (Compilers)', undefined],
      ['Software Engineer Intern (Compilers)', true],
    ]);
  });

  it('matches one role across sources only when the employer and the role agree', () => {
    expect(sameRole({ company: 'Acme', title: 'Software Engineer Intern' },
      { company: 'ACME', title: 'Software Engineer Intern (Backend)' })).toBe(true);
    expect(sameRole({ company: 'Acme', title: 'Software Engineer Intern' },
      { company: 'Beta', title: 'Software Engineer Intern' })).toBe(false);
    expect(sameRole({ company: 'Acme', title: 'Data Engineer Intern' },
      { company: 'Acme', title: 'Hardware Engineer Intern' })).toBe(false);
  });
});
