import { describe, expect, it } from 'vitest';
import { SOURCE_METADATA_PROCESSING_REVISION } from '../src/ingestion/processor.js';
import { Poller } from '../src/poll.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const sourceId = 'metadata-refresh-reappearance-review';
const listing = (index: number): RawListing => ({
  sourceId, document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: index + 1,
  externalId: `role-${String(index).padStart(2, '0')}`, company: 'Acme', title: `Software Engineering Intern ${index}`,
  location: 'Remote', season: 'summer-2027', applyUrl: `https://jobs.example.com/${index}`,
  compensation: { raw: '' }, state: 'open', fetchedAt: '2026-09-06T12:00:00.000Z',
});

class MutableAdapter implements SourceAdapter {
  readonly id = sourceId;
  constructor(readonly listings: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId, listings: this.listings, notModified: false, checkpoint: {
      sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
      lastSuccessAt: '2026-09-06T12:00:00.000Z', lastRowCount: this.listings.length,
    } };
  }
}

describe('bounded metadata refresh review regressions', () => {
  it('reconciles a processed row that reappears after an omission slice before certifying the refresh', async () => {
    const all = Array.from({ length: 30 }, (_, index) => listing(index));
    const adapter = new MutableAdapter([...all]);
    const store = new MemoryInternshipStore();
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });

    await poll();
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1,
      metadataProcessingRevision: SOURCE_METADATA_PROCESSING_REVISION - 1 });
    expect((await poll()).continuationSources).toEqual([sourceId]); // roles 00–19 processed

    adapter.listings.splice(0, adapter.listings.length, ...all.slice(25));
    expect((await poll()).continuationSources).toEqual([sourceId]); // roles 25–29 processed; omissions deferred
    expect((await poll()).continuationSources).toEqual([sourceId]); // first 20 omissions, including role-05
    expect((await store.getSourceOccurrences(sourceId)).find(row => row.externalId === 'role-05')).toMatchObject({ present: false });

    adapter.listings.push(all[5]!); // unchanged material reappears while five omissions remain
    expect((await poll()).continuationSources).toEqual([sourceId]);
    expect((await store.getSourceOccurrences(sourceId)).find(row => row.externalId === 'role-05')).toMatchObject({
      present: true, consecutiveOmissions: 0, occurrence: { state: 'open' },
    });
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION - 1);
    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    // Reappearance restores source presence; canonical job reopening remains
    // governed by the ordinary reconciler's existing lifecycle policy.
  });
});
