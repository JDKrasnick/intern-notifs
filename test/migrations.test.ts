import { describe, expect, it } from 'vitest';
import { hasLifecycleTitleSignal, inferSeason } from '../src/core/early-career.js';
import { occurrenceStatus } from '../src/ingestion/monitoring.js';
import { backfilledExternalId } from '../src/migrate-source-occurrences.js';
import { publishedLeverSources, reviewedLeverSources, type ReviewedLeverSource } from '../src/sources/lever-config.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { IngestionRunner } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { SourceOccurrence } from '../src/types.js';

const reference = (overrides: Partial<SourceOccurrence>): SourceOccurrence => ({
  sourceId: 'markdown-fixture',
  document: 'README.md',
  sourceUrl: 'https://github.test/list',
  row: 3,
  company: 'Acme',
  title: 'Software Engineering Intern',
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: 'https://careers.example.test/acme?utm_source=list',
  compensation: { raw: '' },
  state: 'open',
  ...overrides,
});

describe('lifecycle title signal', () => {
  it('accepts singular and plural early-career titles', () => {
    for (const title of ['Software Engineering Intern', 'AI Internship', 'AI Internships', 'Co-op', 'Co-ops', 'Apprentices']) {
      expect(hasLifecycleTitleSignal(title), title).toBe(true);
    }
  });

  it('accepts graduate and entry-level programmes alongside internships', () => {
    for (const title of ['Software Engineer, New Grad', 'New Graduate Software Engineer', 'University Graduate - Backend',
      'Graduate Programme 2027', 'Graduate Rotational Engineer', 'Early Career Software Engineer',
      'Entry-Level Data Analyst', 'Working Student - Embedded Systems']) {
      expect(hasLifecycleTitleSignal(title), title).toBe(true);
    }
  });

  it('still rejects titles that only look early-career', () => {
    for (const title of ['Internal Auditor', 'International Sales Lead', 'Senior Software Engineer',
      'Graduate Research Assistant', 'Campus Recruiter', 'Director of Graduate Admissions']) {
      expect(hasLifecycleTitleSignal(title), title).toBe(false);
    }
  });
});

describe('season inference', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');

  it('reads a named hiring season from the title or description', () => {
    expect(inferSeason('Software Engineering Intern, Summer 2027', '', now)).toBe('summer-2027');
    expect(inferSeason('Data Intern', 'Starts in the fall 2026 cohort.', now)).toBe('fall-2026');
  });

  it('accepts a bare year only inside the plausible hiring window', () => {
    expect(inferSeason('2027 Software Engineering Internship', '', now)).toBe('2027');
    // A founding year or copyright date must never become part of role identity.
    expect(inferSeason('AI-First Engineering Intern', 'Founded in 2010, we build tools.', now)).toBe('ongoing');
    expect(inferSeason('Engineering Intern', 'Copyright 2015-2019. Apply now.', now)).toBe('ongoing');
    expect(inferSeason('Engineering Intern', 'Programme runs through 2031.', now)).toBe('ongoing');
  });
});

describe('source occurrence backfill', () => {
  it('derives the identity each connector would produce', () => {
    expect(backfilledExternalId(reference({}))).toBe('README.md:https://careers.example.test/acme');
    expect(backfilledExternalId(reference({ sourceId: 'lever-acme', document: 'lever-role-1' }))).toBe('lever-role-1');
    expect(backfilledExternalId(reference({ sourceId: 'shadow-greenhouse-acme', document: '5001' }))).toBe('5001');
    expect(backfilledExternalId(reference({ externalId: 'explicit' }))).toBe('explicit');
    expect(backfilledExternalId(reference({ document: undefined }))).toBeUndefined();
  });

  it('matches the identity the Markdown connector stores for the same row', async () => {
    const adapter = new GitHubMarkdownAdapter({
      id: 'markdown-fixture', owner: 'owner', repo: 'repo',
      documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response('| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n'
        + '| Acme | Software Engineering Intern | Remote | [Apply](https://careers.example.test/acme?utm_source=list) |'),
    });
    const store = new MemoryInternshipStore();
    await new IngestionRunner([adapter], store).run();
    const stored = (await store.getSourceOccurrences('markdown-fixture'))[0]!;
    expect(backfilledExternalId(stored.occurrence)).toBe(stored.externalId);
  });
});

describe('occurrence status', () => {
  const occurrence = {
    sourceId: 'markdown-fixture', externalId: 'README.md:role-1', jobId: 'job-1',
    occurrence: reference({}), present: true, consecutiveOmissions: 0,
    changedSnapshotHash: 'hash-1', changedAt: '2026-07-28T12:00:00.000Z',
  };

  it('reports the confirming snapshot separately from the last change', () => {
    expect(occurrenceStatus(occurrence, {
      sourceId: 'markdown-fixture', successfulFetches: 4, contentHash: 'hash-2',
      activeExternalIds: ['README.md:role-1'], lastSuccessAt: '2026-07-29T12:00:00.000Z',
    })).toMatchObject({
      changedSnapshotHash: 'hash-1',
      changedAt: '2026-07-28T12:00:00.000Z',
      confirmedSnapshotHash: 'hash-2',
      confirmedAt: '2026-07-29T12:00:00.000Z',
    });
  });

  it('leaves confirmation absent when the active snapshot no longer lists the occurrence', () => {
    const status = occurrenceStatus(occurrence, {
      sourceId: 'markdown-fixture', successfulFetches: 4, contentHash: 'hash-2',
      activeExternalIds: [], lastSuccessAt: '2026-07-29T12:00:00.000Z',
    });
    expect(status.confirmedSnapshotHash).toBeUndefined();
    expect(status.confirmedAt).toBeUndefined();
  });
});

describe('reviewed Lever registry', () => {
  it('records employer-controlled ownership evidence for every board', () => {
    for (const source of reviewedLeverSources) {
      expect(new URL(source.careersUrl).protocol, source.id).toBe('https:');
      // The evidence page must be the employer's own, never Lever's or an aggregator's.
      expect(new URL(source.careersUrl).hostname, source.id).not.toMatch(/lever\.co|simplify\.jobs/);
      expect(Number.isNaN(Date.parse(source.admittedAt)), source.id).toBe(false);
      expect(source.id, source.id).toBe(`lever-${source.id.replace(/^lever-/, '')}`);
    }
  });

  it('polls published boards only, so promotion is one field', () => {
    const shadow: ReviewedLeverSource = {
      id: 'lever-candidate', company: 'Candidate', site: 'candidate',
      careersUrl: 'https://candidate.example/careers', admittedAt: '2026-07-29',
      status: 'shadow', region: 'global', evidenceStatus: 'legacy-review',
    };
    expect(publishedLeverSources([...reviewedLeverSources, shadow]).map((source) => source.id))
      .toEqual(reviewedLeverSources.filter((source) => source.status === 'published').map((source) => source.id));
    expect(publishedLeverSources([{ ...shadow, status: 'published' }])).toHaveLength(1);
  });
});
