import { describe, expect, it } from 'vitest';
import { catalogQualityBackfillPlan, runCatalogQualityBackfill, type CatalogQualityRow } from '../src/catalog-quality-backfill.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { Internship } from '../src/types.js';

function job(): Internship {
  return {
    jobId: 'job-1', company: '🇺🇸 Acme', title: '🎓 Software Intern', location: 'NYC', season: 'summer-2027',
    locations: ['NYC'], applyUrl: 'https://example.test/1', normalizedUrl: 'https://example.test/1', fingerprint: 'legacy',
    compensation: { raw: `Description ${'x'.repeat(300)} $45-$55/hour` }, requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
    sourceReferences: [{ sourceId: 'greenhouse-acme', externalId: '1', document: '1', sourceUrl: 'https://boards.greenhouse.io/acme', row: 1,
      company: '🇺🇸 Acme', title: '🎓 Software Intern', location: 'NYC', season: 'summer-2027', applyUrl: 'https://example.test/1',
      compensation: { raw: '$45-$55/hour' }, state: 'open' }], technical: true, open: true,
    firstSeenAt: '2026-08-25T00:00:00.000Z', lastSeenAt: '2026-08-25T00:00:00.000Z', notification: { smsPending: false, digestPending: true },
  };
}

describe('catalog quality backfill planning', () => {
  it('is deterministic, preserves identity and notifications, and becomes idempotent', () => {
    const rows: CatalogQualityRow[] = [{ pk: 'JOB#job-1', sk: 'META', kind: 'internship', value: JSON.stringify(job()) }];
    const first = catalogQualityBackfillPlan(rows);
    expect(first.changed).toHaveLength(1);
    expect(first.changed[0]?.value).toMatchObject({ jobId: 'job-1', notification: { smsPending: false, digestPending: true } });
    expect(catalogQualityBackfillPlan(rows).repairToken).toBe(first.repairToken);
    const repairedRows = rows.map((row) => ({ ...row, value: JSON.stringify(first.changed[0]!.value) }));
    expect(catalogQualityBackfillPlan(repairedRows).changed).toHaveLength(0);
  });

  it('reports malformed JSON without broadening the repair', () => {
    const plan = catalogQualityBackfillPlan([{ pk: 'JOB#bad', sk: 'META', kind: 'internship', value: '{' }]);
    expect(plan.totals.unrepairable).toBe(1);
    expect(plan.changed).toHaveLength(0);
  });

  it('keeps an elapsed role open only when an official checkpoint still confirms explicit season evidence', () => {
    const elapsed = job();
    elapsed.season = 'summer-2025';
    elapsed.internshipIdentity = { season: { evidenceStatus: 'explicit' } };
    const roleRow: CatalogQualityRow = { pk: 'JOB#job-1', sk: 'META', kind: 'internship', value: JSON.stringify(elapsed) };
    expect(catalogQualityBackfillPlan([roleRow]).totals.closed).toBe(1);
    const checkpoint: CatalogQualityRow = {
      pk: 'SOURCE#greenhouse-acme', sk: 'CHECKPOINT', kind: 'checkpoint',
      value: JSON.stringify({ sourceId: 'greenhouse-acme', successfulFetches: 2, activeExternalIds: ['1'] }),
    };
    expect(catalogQualityBackfillPlan([roleRow, checkpoint]).totals.closed).toBe(0);
  });

  it('atomically rejects stale guards and reports conditional-write conflicts without outbox writes', async () => {
    const second = job(); second.jobId = 'job-2'; second.normalizedUrl = 'https://example.test/2'; second.applyUrl = second.normalizedUrl;
    const rows: CatalogQualityRow[] = [
      { pk: 'JOB#job-1', sk: 'META', kind: 'internship', value: JSON.stringify(job()) },
      { pk: 'JOB#job-2', sk: 'META', kind: 'internship', value: JSON.stringify(second) },
    ];
    const queries: string[] = [];
    let batchCalls = 0;
    const database = {
      prepare(query: string) {
        queries.push(query);
        const statement: D1PreparedStatement = {
          bind() { return statement; },
          async first() { return null; },
          async all<T>() {
            return { results: (/SELECT json_extract\(staged\.value, '\$\.id'\)/u.test(query) ? [{ id: 'job-2' }] : rows) as T[] };
          },
          async run() { return { meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { batchCalls += 1; return []; },
    } satisfies D1Database;
    await expect(runCatalogQualityBackfill(database, { apply: true, repairToken: 'stale', expectedChanged: 2 })).rejects.toThrow(/changed after dry run/iu);
    const dryRun = await runCatalogQualityBackfill(database);
    const apply = await runCatalogQualityBackfill(database, { apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged });
    expect(apply.conflicts).toEqual(['job-2']);
    expect(apply.projectionRefreshRequired).toBe(false);
    expect(batchCalls).toBe(1);
    const catalogUpdates = queries.filter((query) => /UPDATE catalog_items AS target/u.test(query));
    expect(catalogUpdates).toHaveLength(1);
    expect(catalogUpdates[0]).toMatch(/matching_count[\s\S]+staged_count[\s\S]+matching_count/u);
    expect(queries.every((query) => !/outbox|notification-event/iu.test(query))).toBe(true);
  });
});
