import { describe, expect, it } from 'vitest';
import { IngestionRunner } from '../src/poll.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { MemoryInternshipStore } from '../src/store.js';
import { buildInternshipIdentity } from '../src/identity/enrichment.js';
import { extractPostingMetadataEvidence } from '../src/role-metadata.js';
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
  applyUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
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
  it('reprojects changed source metadata without creating a second new-role event', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 1 });
    const metadata = (pay: string, observedAt: string) => extractPostingMetadataEvidence({
      artifact: { title: 'Software Engineering Intern', compensationText: pay },
      sourceClass: 'official-ats', sourceId: 'source-a', sourceUrl: 'https://source.example.test/source-a', observedAt, exactPosting: true,
    });
    const adapter = new MutableAdapter('source-a', [listing('source-a', { metadataEvidence: metadata('USD $40/hour', '2026-07-29T12:00:00.000Z') })]);
    await new IngestionRunner([adapter], store, () => new Date('2026-07-29T12:00:00.000Z')).run();
    const original = [...store.jobs.values()][0]!;
    expect(original.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 40 });
    expect(store.notificationEvents.size).toBe(1);

    adapter.rows = [listing('source-a', { metadataEvidence: metadata('USD $45/hour', '2026-07-30T12:00:00.000Z') })];
    await new IngestionRunner([adapter], store, () => new Date('2026-07-30T12:00:00.000Z')).run();
    const updated = [...store.jobs.values()][0]!;
    expect(updated.compensation).toMatchObject({ minHourlyUSD: 45, maxHourlyUSD: 45 });
    expect(updated.jobId).toBe(original.jobId);
    expect(updated.firstSeenAt).toBe(original.firstSeenAt);
    expect(updated.notification).toEqual(original.notification);
    expect(store.notificationEvents.size).toBe(1);

    adapter.rows = [listing('source-a', { metadataEvidence: metadata('', '2026-07-31T12:00:00.000Z') })];
    await new IngestionRunner([adapter], store, () => new Date('2026-07-31T12:00:00.000Z')).run();
    const removed = [...store.jobs.values()][0]!;
    expect(removed.compensation).toEqual({ raw: '' });
    expect(removed.roleMetadata).toBeUndefined();
    expect(store.notificationEvents.size).toBe(1);
  });

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

  it('closes an elapsed role when its last official occurrence closes', async () => {
    const store = new MemoryInternshipStore();
    const community = new MutableAdapter('github-list', [listing('github-list', { season: 'summer-2025', provenance: 'reviewed-community' })]);
    const officialListing = listing('greenhouse-acme', {
      provenance: 'official-ats',
      season: 'summer-2025',
      internshipIdentity: buildInternshipIdentity({
        sourceId: 'greenhouse-acme', sourceUrl: 'https://source.example.test/greenhouse-acme', observedAt: '2026-07-29T12:00:00.000Z',
        company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2025', seasonEvidenceStatus: 'explicit',
      }),
    });
    const official = new MutableAdapter('greenhouse-acme', [officialListing]);
    await new IngestionRunner([community, official], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });

    official.rows = [];
    await new IngestionRunner([official], store).run();
    await new IngestionRunner([official], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ open: false });
    expect([...store.jobs.values()][0]?.sourceReferences).toEqual([
      expect.objectContaining({ sourceId: 'github-list', state: 'open' }),
      expect.objectContaining({ sourceId: 'greenhouse-acme', state: 'closed' }),
    ]);
  });

  it('keeps source observation facts immutable and timestamps an exact later attachment', async () => {
    const store = new MemoryInternshipStore();
    const aggregator = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([aggregator], store).run();
    const first = (await store.getSourceOccurrences('source-a'))[0]!;
    const firstReference = [...store.jobs.values()][0]!.sourceReferences[0]!;

    await new IngestionRunner([aggregator], store).run();
    const repeated = (await store.getSourceOccurrences('source-a'))[0]!;
    expect(repeated.firstObservedAt).toBe(first.firstObservedAt);
    expect(repeated.firstObservedAtPrecision).toBe('exact');
    expect(repeated.occurrence).toMatchObject({
      firstAttachedAt: first.firstObservedAt,
      firstAttachedAtPrecision: 'exact',
    });
    expect([...store.jobs.values()][0]!.sourceReferences[0]).toMatchObject({
      firstAttachedAt: firstReference.firstAttachedAt,
      firstAttachedAtPrecision: 'exact',
    });

    const provider = new MutableAdapter('source-b', [listing('source-b', {
      providerTimestamp: { value: '2026-07-01T00:00:00.000Z', semantics: 'updated' },
    })]);
    await new IngestionRunner([provider], store).run();
    const attached = [...store.jobs.values()][0]!.sourceReferences.find((reference) => reference.sourceId === 'source-b')!;
    const providerOccurrence = (await store.getSourceOccurrences('source-b'))[0]!;
    expect(attached).toMatchObject({
      firstAttachedAt: providerOccurrence.firstObservedAt, firstAttachedAtPrecision: 'exact',
      providerTimestamp: { value: '2026-07-01T00:00:00.000Z', semantics: 'updated' },
    });
    expect([...store.jobs.values()][0]).toMatchObject({
      firstSeenAt: first.firstObservedAt, catalogVisibleAt: first.firstObservedAt,
    });
    expect(providerOccurrence.firstObservedAt).not.toBe(attached.providerTimestamp?.value);
  });

  it('keeps a role catalogued while any open source occurrence classifies it as technical', async () => {
    const store = new MemoryInternshipStore();
    const technical = new MutableAdapter('source-technical', [listing('source-technical', { technical: true })]);
    const shelved = new MutableAdapter('source-shelved', [listing('source-shelved', { technical: false })]);

    await new IngestionRunner([technical], store).run();
    await new IngestionRunner([shelved], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ technical: true, open: true });
    expect((await store.listOpen()).jobs).toHaveLength(1);
    expect([...store.jobs.values()][0]?.sourceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'source-technical', technical: true }),
      expect.objectContaining({ sourceId: 'source-shelved', technical: false }),
    ]));
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
      .toEqual(['INTERN_INTL.md', 'README.md']);
  });

  it('keeps the canonical alert tombstone when one duplicate occurrence commit fails', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.fail && !('sourceId' in input)) {
          this.fail = false;
          throw new Error('first duplicate commit failed');
        }
        return super.commitPostingObservation(input);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [
      listing('source-a', { externalId: 'README.md:role-1', document: 'README.md' }),
      listing('source-a', { externalId: 'INTERN_INTL.md:role-1', document: 'INTERN_INTL.md' }),
    ]);

    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['first duplicate commit failed']);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
    expect(store.occurrences.size).toBe(1);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(0);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
    expect(store.occurrences.size).toBe(2);
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

  it('prefers cleaned official evidence over community display fields', async () => {
    const store = new MemoryInternshipStore();
    const community = new MutableAdapter('community-list', [listing('community-list', {
      provenance: 'reviewed-community', company: 'Community Acme', title: 'SWE Intern', location: 'Unspecified',
    })]);
    await new IngestionRunner([community], store).run();
    const official = new MutableAdapter('greenhouse-acme', [listing('greenhouse-acme', {
      provenance: 'official-ats', company: '🇺🇸 Acme', title: '🎓 Advanced Degree Required · Software Engineering Intern', location: 'NYC',
    })]);
    await new IngestionRunner([official], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({
      company: 'Acme', title: 'Software Engineering Intern', location: 'New York, NY',
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true },
    });
    community.rows = [listing('community-list', { provenance: 'reviewed-community', company: 'Bad community value', title: 'Bad title', location: 'Unspecified' })];
    await new IngestionRunner([community], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Acme', title: 'Software Engineering Intern', location: 'New York, NY' });
  });

  it('does not advance a checkpoint or duplicate an outbox event after a partial write failure', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.fail) { this.fail = false; throw new Error('occurrence write failed'); }
        return super.commitPostingObservation(input);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['occurrence write failed']);
    expect(failed.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(0);
    expect(store.occurrences.size).toBe(0);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(0);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toHaveLength(1);
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
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.fail) {
          this.fail = false;
          throw new Error('outbox transaction failed');
        }
        return super.commitPostingObservation(input);
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
