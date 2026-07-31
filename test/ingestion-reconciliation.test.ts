import { describe, expect, it } from 'vitest';
import { IngestionRunner } from '../src/poll.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { Internship, ProcessedListing, SourceAdapter, SourceCheckpoint, SourceFetchResult, SourceOccurrenceState } from '../src/types.js';

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

  it('keeps a role catalogued while any open source occurrence classifies it as technical', async () => {
    const store = new MemoryInternshipStore();
    const technical = new MutableAdapter('source-technical', [listing('source-technical', { technical: true })]);
    const shelved = new MutableAdapter('source-shelved', [listing('source-shelved', { technical: false })]);

    await new IngestionRunner([technical], store).run();
    await new IngestionRunner([shelved], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ technical: true, open: true });
    expect((await store.listOpen()).jobs).toHaveLength(1);
    expect([...store.jobs.values()][0]?.sourceReferences).toEqual([
      expect.objectContaining({ sourceId: 'source-technical', technical: true }),
      expect.objectContaining({ sourceId: 'source-shelved', technical: false }),
    ]);
  });

  it('closes a Markdown occurrence the connector stops listing', async () => {
    const rows = [
      '| Acme | Software Engineering Intern | Remote | [Apply](https://careers.example.test/acme) |',
      '| Beta | Data Science Intern | NYC | [Apply](https://careers.example.test/beta) |',
    ];
    let body = () => `| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
    const adapter = new GitHubMarkdownAdapter({
      id: 'markdown-fixture', owner: 'owner', repo: 'repo',
      documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response(body()),
    });
    const store = new MemoryInternshipStore();
    await new IngestionRunner([adapter], store).run();
    const dropped = [...store.jobs.values()].find((job) => job.company === 'Beta')!;

    body = () => `| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n${rows[0]}`;
    await new IngestionRunner([adapter], store).run();
    expect((await store.getJob(dropped.jobId))?.open).toBe(true);

    await new IngestionRunner([adapter], store).run();
    expect((await store.getJob(dropped.jobId))?.open).toBe(false);
    expect((await store.getJob([...store.jobs.values()].find((job) => job.company === 'Acme')!.jobId))?.open).toBe(true);
  });

  it('merges one role listed twice in a snapshot into a single alert and role', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 2 });
    const adapter = new MutableAdapter('source-a', [
      listing('source-a', { externalId: 'README.md:role-1', document: 'README.md' }),
      listing('source-a', { externalId: 'INTERN_INTL.md:role-1', document: 'INTERN_INTL.md' }),
    ]);
    const report = await new IngestionRunner([adapter], store).run();

    expect(report.newJobs).toHaveLength(1);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
    expect([...store.jobs.values()][0]?.sourceReferences.map((reference) => reference.document))
      .toEqual(['README.md', 'INTERN_INTL.md']);
  });

  it('updates the stored season when a source correction arrives', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([adapter], store).run();

    adapter.rows = [listing('source-a', { season: 'summer-2026' })];
    await new IngestionRunner([adapter], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ season: 'summer-2026' });
  });

  it('touches no catalog record for an unchanged snapshot that confirms the active occurrences', async () => {
    let operations = 0;
    class CountingStore extends MemoryInternshipStore {
      override async putInternship(job: Internship) { operations += 1; return super.putInternship(job); }
      override async putSourceOccurrence(value: SourceOccurrenceState) { operations += 1; return super.putSourceOccurrence(value); }
      override async getJob(jobId: string) { operations += 1; return super.getJob(jobId); }
      override async findByUrl(url: string) { operations += 1; return super.findByUrl(url); }
    }
    const store = new CountingStore();
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([adapter], store).run();

    operations = 0;
    adapter.unchanged = true;
    const report = await new IngestionRunner([adapter], store).run();

    expect(report.unchangedSources).toEqual(['source-a']);
    expect(operations).toBe(0);
    expect((await store.getSourceOccurrences('source-a'))[0]).toMatchObject({ present: true, consecutiveOmissions: 0 });
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
    expect(failed.newJobs).toHaveLength(1);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(0);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toEqual([]);
    expect(store.notificationEvents.size).toBe(1);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(1);

    // A later retry re-derives the same create; the recorded outbox event keeps it quiet.
    store.occurrences.clear();
    const replayed = await new IngestionRunner([adapter], store).run();
    expect(replayed.newJobs).toEqual([]);
    expect(store.notificationEvents.size).toBe(1);
  });

  it('retries an atomic job and outbox write without exposing pending delivery state first', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async putInternshipWithNotificationEvent(
        job: Internship,
        event: Parameters<MemoryInternshipStore['putInternshipWithNotificationEvent']>[1],
      ) {
        if (this.fail) {
          this.fail = false;
          throw new Error('outbox transaction failed');
        }
        return super.putInternshipWithNotificationEvent(job, event);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);

    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['outbox transaction failed']);
    expect(failed.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(0);
    expect(store.notificationEvents.size).toBe(0);
    expect(await store.pendingDigest()).toEqual([]);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toHaveLength(1);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
  });
});
