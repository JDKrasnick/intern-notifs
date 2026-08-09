import { describe, expect, it } from 'vitest';
import { AshbyPostingsAdapter } from '../src/sources/ashby.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';

// Opt-in, read-only public contract. The adapter itself validates API version,
// schema, exact board paths, UUID identity, publication dates, and application
// hosts before the assertions below inspect the neutral snapshot.
const enabled = process.env.ASHBY_LIVE === '1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe.skipIf(!enabled)('Ashby live public-API contract', () => {
  it.each(reviewedAshbySources.map((source) => [source.id, source] as const))(
    '%s returns a valid listed-only neutral snapshot',
    async (_id, source) => {
      const result = await new AshbyPostingsAdapter({ source }).fetch();
      const activeIds = result.checkpoint.activeExternalIds ?? [];
      expect(activeIds).toHaveLength(result.rawCount);
      expect(new Set(activeIds).size).toBe(activeIds.length);
      expect(activeIds.every((id) => uuidPattern.test(id))).toBe(true);
      expect(result.postings.every((posting) => activeIds.includes(posting.externalId))).toBe(true);
      expect(result.rejectedApplicationUrls, JSON.stringify(result.rejectedApplicationUrls)).toEqual([]);
      expect(result.processed.counts.raw).toBe(result.rawCount);
      expect(result.processed.counts.valid + result.processed.counts.withheld).toBe(result.rawCount);
      expect(result.processed.counts.eligible + result.processed.counts.shelved).toBe(result.processed.listings.length);
      console.log(`[ashby-live] ${source.id}`, JSON.stringify({
        listed: result.rawCount,
        eligible: result.processed.counts.eligible,
        shelved: result.processed.counts.shelved,
        filtered: result.processed.counts.filtered,
        withheld: result.processed.counts.withheld,
        hash: result.contentHash,
      }));
    },
    30_000,
  );
});
