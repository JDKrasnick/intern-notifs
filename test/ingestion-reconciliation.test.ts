import { describe, expect, it } from 'vitest';
import { IngestionRunner } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { ProcessedListing, SourceAdapter, SourceCheckpoint, SourceFetchResult, SourceOccurrenceState } from '../src/types.js';

const listing = (sourceId: string, overrides: Partial<ProcessedListing> = {}): ProcessedListing => ({
  sourceId,
  externalId: 'role-1',
  document: 'role-1',
  sourceUrl: `https://source.example.test/${sourceId}`,
  row: 1,
  company: 'Acme',
  title: 'Software Engineering Intern',
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: 'https://careers.example.test/role-1',
  compensation: { raw: '' },
  requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
  state: 'open',
  fetchedAt: '2026-07-29T12:00:00.000Z',
  technical: true,
  ...overrides,
});

class MutableAdapter implements SourceAdapter {
  rows: ProcessedListing[];
  unchanged = false;
  constructor(readonly id: string, rows: ProcessedListing[]) { this.rows = rows; }
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return {
      sourceId: this.id,
      rawRowCount: 1,
      listings: this.rows,
      notModified: this.unchanged,
      checkpoint: {
        sourceId: this.id,
        contentHash: this.rows.length ? 'present' : 'omitted',
        successfulFetches: (previous?.successfulFetches ?? 0) + (this.unchanged ? 0 : 1),
        lastRowCount: this.rows.length,
        activeExternalIds: this.rows.map((row) => row.externalId!),
      },
    };
  }
}

describe('snapshot reconciliation', () => {
  it('closes an occurrence after two complete omissions, including an unchanged confirmation', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([adapter], store).run();

    adapter.rows = [];
    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });
    expect((await store.getSourceOccurrences('source-a'))[0]).toMatchObject({ present: false, consecutiveOmissions: 1 });

    adapter.unchanged = true;
    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: false });
    expect((await store.getSourceOccurrences('source-a'))[0]).toMatchObject({ present: false, consecutiveOmissions: 2 });
  });

  it('keeps a catalog role open while another source occurrence remains open', async () => {
    const store = new MemoryInternshipStore();
    const first = new MutableAdapter('source-a', [listing('source-a')]);
    const second = new MutableAdapter('source-b', [listing('source-b')]);
    await new IngestionRunner([first, second], store).run();
    first.rows = [];
    await new IngestionRunner([first], store).run();
    first.unchanged = true;
    await new IngestionRunner([first], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });
    expect([...store.jobs.values()][0].sourceReferences).toEqual([
      expect.objectContaining({ sourceId: 'source-a', state: 'closed' }),
      expect.objectContaining({ sourceId: 'source-b', state: 'open' }),
    ]);
  });

  it('does not advance a checkpoint or duplicate an outbox event after a partial write failure', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async putSourceOccurrence(value: SourceOccurrenceState) {
        if (this.fail) { this.fail = false; throw new Error('occurrence write failed'); }
        return super.putSourceOccurrence(value);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['occurrence write failed']);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(0);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toHaveLength(1);
    expect(store.notificationEvents.size).toBe(1);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(1);
  });
});
