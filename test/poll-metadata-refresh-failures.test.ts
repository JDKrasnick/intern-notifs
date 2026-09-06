import { describe, expect, it } from 'vitest';
import { Poller } from '../src/poll.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { Internship, RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const sourceId = 'metadata-refresh-failure-fixture';
const row = (id: string): RawListing => ({
  sourceId, externalId: id, document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: 1,
  company: 'Acme', title: `Software Engineering Intern ${id}`, location: 'Remote', season: 'summer-2027',
  applyUrl: `https://jobs.example.com/${id}`, compensation: { raw: '' }, state: 'open',
  fetchedAt: '2026-09-06T12:00:00.000Z',
});

class Adapter implements SourceAdapter {
  readonly id = sourceId;
  constructor(readonly listings: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId, listings: this.listings, notModified: false,
      checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastSuccessAt: '2026-09-06T12:00:00.000Z', lastRowCount: this.listings.length } };
  }
}

const resolver = {
  async configurationVersion() { return 'fixture-v1'; },
  async resolveCanonicalEmployer() { return undefined; },
  async resolveDestinationRule() { return undefined; },
};

describe('bounded metadata refresh persistence failures', () => {
  it('does not checkpoint an omission when the legacy closed-job fallback fails', async () => {
    class ClosedJobFailureStore extends MemoryInternshipStore {
      failClosedJob = false;
      override async putInternship(job: Internship) {
        if (this.failClosedJob && !job.open) { this.failClosedJob = false; throw new Error('closed job write failed'); }
        return super.putInternship(job);
      }
    }
    const store = new ClosedJobFailureStore();
    const adapter = new Adapter([row('active'), row('missing')]);
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const missing = (await store.getSourceOccurrences(sourceId)).find((item) => item.externalId === 'missing')!;
    store.occurrences.set(`${sourceId}#missing`, { ...missing, present: true, consecutiveOmissions: 1,
      occurrence: { ...missing.occurrence, postingIdentityDecision: undefined } });
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    adapter.listings.splice(0, adapter.listings.length, row('active'));
    await poll(); // current-row metadata slice; lifecycle work follows separately
    store.failClosedJob = true;

    const failed = await poll();
    expect(failed.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataOmissions?.map((item) => item.externalId))
      .not.toContain('missing');
    expect((await store.getJob(missing.jobId))?.open).toBe(true);

    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getJob(missing.jobId))?.open).toBe(false);
  });

  it('does not checkpoint a legacy row when its combined job/event write fails', async () => {
    class EventFailureStore extends MemoryInternshipStore {
      failEvent = true;
      override async putInternshipWithNotificationEvent(job: Internship, event: Parameters<MemoryInternshipStore['putInternshipWithNotificationEvent']>[1]) {
        if (this.failEvent) { this.failEvent = false; throw new Error('legacy event write failed'); }
        return super.putInternshipWithNotificationEvent(job, event);
      }
    }
    const store = new EventFailureStore();
    await store.putCheckpoint({ sourceId, successfulFetches: 1, lastSuccessAt: '2026-09-05T12:00:00.000Z',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    const adapter = new Adapter([row('new-role')]);
    const poll = () => {
      const runner = new Poller([adapter], store, undefined, undefined,
        async (url) => url, undefined, undefined, resolver);
      const internals = runner as unknown as { reconciler: { reconcile(input: unknown): {
        occurrences: Array<{ occurrence: RawListing }>; [key: string]: unknown;
      } } };
      const original = internals.reconciler;
      internals.reconciler = { reconcile(input) {
        const plan = original.reconcile(input);
        return { ...plan, occurrences: plan.occurrences.map((item) => ({ ...item,
          occurrence: { ...item.occurrence, postingIdentityDecision: undefined } })) };
      } };
      return runner.poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    };

    const failed = await poll();
    expect(failed.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataProcessedRows?.map((item) => item.externalId))
      .not.toContain('new-role');
    expect(store.notificationEvents.size).toBe(0);

    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    expect(store.notificationEvents.size).toBe(1);
  });
});
