import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { Internship } from '../src/types.js';

function job(jobId: string, title: string): Internship {
  return {
    jobId,
    company: 'Acme',
    title,
    location: 'New York, NY',
    season: 'summer-2027',
    applyUrl: `https://careers.example.test/${jobId}`,
    normalizedUrl: `https://careers.example.test/${jobId}`,
    fingerprint: jobId,
    compensation: { raw: '' },
    sourceReferences: [],
    technical: true,
    open: true,
    firstSeenAt: '2026-08-25T00:00:00.000Z',
    catalogVisibleAt: '2026-08-25T00:00:00.000Z',
    lastSeenAt: '2026-08-25T00:00:00.000Z',
    employerCategory: 'normal',
    requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
    notification: { smsPending: false, digestPending: false },
  };
}

describe('D1 filtered catalog projection', () => {
  it('filters roles in one projection query and returns a matched-page cursor', async () => {
    const details = groupCatalogJobs([
      job('software', 'Software Engineering Intern'),
      job('machine', 'Machine Learning Intern'),
    ]).map(catalogGroupDetails).find((group) => group.roles.some((role) => role.jobId === 'machine'))!;
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const database = {
      prepare(query: string) {
        const call = { query, values: [] as unknown[] };
        prepared.push(call);
        const statement: D1PreparedStatement = {
          bind(...values: unknown[]) { call.values = values; return statement; },
          async first<T>() {
            return { value: JSON.stringify({ version: 'version-a', generatedAt: new Date().toISOString(), schemaVersion: 3 }) } as T;
          },
          async all<T>() { return { results: [{ value: JSON.stringify(details) } as T, { value: JSON.stringify(details) } as T] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } satisfies D1Database;

    const page = await new D1InternshipStore(database).listCatalogProjectionFiltered(undefined, 1, {
      status: 'open',
      query: 'machine',
      employerCategories: ['normal'],
      hideUsCitizenshipRequired: true,
      hideAdvancedDegreeRequired: true,
    });

    expect(page).toMatchObject({
      cursor: '1',
      groups: [{ group: { roleCount: 1, titles: ['Machine Learning Intern'] }, roles: [{ jobId: 'machine' }] }],
    });
    expect(prepared).toHaveLength(2);
    expect(prepared[1]!.query).toContain("json_each(projection.value, '$.roles')");
    expect(prepared[1]!.query).toContain("json_extract(role.value, '$.employerCategory') IN (?)");
    expect(prepared[1]!.values).toEqual(expect.arrayContaining(['%machine%', 'normal', 2, 0]));
  });
});
