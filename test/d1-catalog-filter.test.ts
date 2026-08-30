import { DatabaseSync, type StatementSync } from 'node:sqlite';
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

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query);
    const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return {
    prepare(query: string) { return prepared(query); },
    async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); },
  };
}

describe('D1 filtered catalog projection', () => {
  it('packs a production-sized projection within D1 query and binding budgets', async () => {
    const template = catalogGroupDetails(groupCatalogJobs([job('template', 'Software Engineering Intern')])[0]!);
    const groups = Array.from({ length: 1_503 }, (_, index) => ({
      ...template,
      group: { ...template.group, groupId: `group-${index}` },
      roles: template.roles.map((role) => ({ ...role, jobId: `job-${index}` })),
    }));
    const batchSizes: number[] = []; let maxBoundParameters = 0;
    const database = {
      prepare() {
        const statement: D1PreparedStatement = {
          bind(...values: unknown[]) { maxBoundParameters = Math.max(maxBoundParameters, values.length); return statement; },
          async first<T>() { return null as T | null; },
          async all<T>() { return { results: [] as T[] }; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements: D1PreparedStatement[]) {
        batchSizes.push(statements.length);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } satisfies D1Database;

    await new D1InternshipStore(database).putCatalogProjection(groups, '2026-08-27T00:00:00.000Z');

    expect(batchSizes).toEqual([50, 11]);
    expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(61);
    expect(maxBoundParameters).toBeLessThanOrEqual(100);
  });

  it('writes multi-row projection batches with stable global ordering', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const template = catalogGroupDetails(groupCatalogJobs([job('template', 'Software Engineering Intern')])[0]!);
    const groups = Array.from({ length: 26 }, (_, index) => ({
      ...template,
      group: { ...template.group, groupId: `group-${index}` },
      roles: template.roles.map((role) => ({ ...role, jobId: `job-${index}` })),
    }));
    try {
      await new D1InternshipStore(sqliteD1(database)).putCatalogProjection(groups, '2026-08-27T00:00:00.000Z');
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 26 });
      expect(database.prepare("SELECT MIN(catalog_sort_key) AS first, MAX(catalog_sort_key) AS last FROM catalog_items WHERE kind = 'catalog-projection'").get())
        .toEqual({ first: '00000000', last: '00000025' });
    } finally {
      database.close();
    }
  });

  it('matches normalized role locations when the raw label is generic', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const details = catalogGroupDetails(groupCatalogJobs([job('location', 'Software Engineering Intern')])[0]!);
    details.roles[0]!.location = 'Multiple Locations';
    details.roles[0]!.locations = ['Ithaca, NY'];
    const generatedAt = new Date().toISOString();
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({ version: 'version-a', generatedAt, schemaVersion: 4 }), null);
    insert.run('CATALOG_PROJECTION#version-a', `GROUP#${details.group.groupId}`, 'catalog-projection', JSON.stringify(details), '00000000');

    try {
      const page = await new D1InternshipStore(sqliteD1(database)).listCatalogProjectionFiltered(undefined, 25, {
        status: 'open', locations: ['Ithaca'],
      });
      expect(page?.groups).toMatchObject([{ roles: [{ jobId: 'location', locations: ['Ithaca, NY'] }] }]);
    } finally {
      database.close();
    }
  });

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
            return { value: JSON.stringify({ version: 'version-a', generatedAt: new Date().toISOString(), schemaVersion: 4 }) } as T;
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
