import { describe, expect, it } from 'vitest';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { runGreenhouseLiveContract } from '../src/sources/greenhouse-live.js';

// Live contract suite. Skipped by the deterministic `npm test` gate; run it with
// `npm run test:greenhouse:live`, which sets GREENHOUSE_LIVE=1. It makes only
// read-only GET requests, no credentials, and treats a network outage as an
// inconclusive infrastructure result rather than accepting or rejecting a board.
const enabled = process.env.GREENHOUSE_LIVE === '1';

describe.skipIf(!enabled)('greenhouse live contract', () => {
  it('reads the reviewed board registry', () => {
    expect(Array.isArray(reviewedGreenhouseSources)).toBe(true);
  });

  it.each(reviewedGreenhouseSources.map((source) => [source.id, source] as const))(
    '%s satisfies identity, schema, ETag, and link-health',
    async (_id, source) => {
      const result = await runGreenhouseLiveContract(source);
      console.log(`[greenhouse-live] ${source.id}`, JSON.stringify({ status: result.status, counts: result.counts, checks: result.checks }));
      if (result.status === 'inconclusive') {
        console.warn(`[greenhouse-live] ${source.id} inconclusive; re-run before admission: ${result.diagnostics.join('; ')}`);
        return;
      }
      expect(result.status, result.diagnostics.join('; ')).toBe('ok');
    },
    45_000,
  );
});
