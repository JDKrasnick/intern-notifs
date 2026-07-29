import { describe, expect, it } from 'vitest';
import { hasLifecycleTitleSignal } from '../src/core/early-career.js';
import { occurrenceStatus } from '../src/ingestion/monitoring.js';
import { backfilledExternalId } from '../src/migrate-source-occurrences.js';
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

  it('still rejects titles that only look early-career', () => {
    for (const title of ['Internal Auditor', 'International Sales Lead', 'Senior Software Engineer']) {
      expect(hasLifecycleTitleSignal(title), title).toBe(false);
    }
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
