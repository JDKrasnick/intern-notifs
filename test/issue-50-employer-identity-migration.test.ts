import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
  };
}

const migrations = new URL('../cloudflare/migrations/', import.meta.url);
const through0010 = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql') && name.localeCompare('0011') < 0)
  .sort();
const migration = readFileSync(new URL('0011_issue_50_reviewed_employer_identity.sql', migrations), 'utf8');

function databaseThrough0010(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const name of through0010) database.exec(readFileSync(new URL(name, migrations), 'utf8'));
  return database;
}

describe('issue #50 reviewed employer identity migration', () => {
  it('upgrades a database through 0010, is idempotent, and resolves every reviewed scope', async () => {
    const database = databaseThrough0010();
    database.exec(migration);
    database.exec(migration);

    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_employers WHERE reviewed_by = 'issue-50-production-review'").get())
      .toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM employer_mappings WHERE reviewed_by = 'issue-50-production-review'").get())
      .toEqual({ count: 10 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM admission_reviewer_decisions WHERE reviewed_by = 'issue-50-production-review'").get())
      .toEqual({ count: 13 });

    const store = new D1CatalogAdmissionStore(sqliteD1(database));
    const cases = [
      ['greenhouse', 'greenhouse-aquaticcapitalmanagement', undefined, 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['github', 'community-list', 'employer:aquatic', 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['github', 'community-list', 'employer:aquatic-capital', 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['github', 'community-list', 'employer:aquatic-capital-management', 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['github', 'community-list', 'employer:aquatic capital', 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['github', 'community-list', 'employer:aquatic capital management', 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['greenhouse', 'greenhouse-jumptrading', undefined, 'jump-trading', 'Jump Trading'],
      ['github', 'community-list', 'employer:jump-trading', 'jump-trading', 'Jump Trading'],
      ['github', 'community-list', 'employer:jumptrading', 'jump-trading', 'Jump Trading'],
      ['github', 'community-list', 'employer:jump trading', 'jump-trading', 'Jump Trading'],
      ['greenhouse', 'greenhouse-squarepointcapital', undefined, 'squarepoint-capital', 'Squarepoint Capital'],
      ['github', 'community-list', 'employer:squarepoint-capital', 'squarepoint-capital', 'Squarepoint Capital'],
      ['github', 'community-list', 'employer:squarepointcapital', 'squarepoint-capital', 'Squarepoint Capital'],
      ['github', 'community-list', 'employer:squarepoint capital', 'squarepoint-capital', 'Squarepoint Capital'],
    ] as const;
    for (const [provider, sourceId, employerScope, id, displayName] of cases) {
      await expect(store.resolveCanonicalEmployer({ provider, sourceId, sourceUrl: 'https://example.test/source', ...(employerScope ? { employerScope } : {}) }))
        .resolves.toEqual({ id, displayName });
    }

    expect(() => database.prepare("UPDATE admission_reviewer_decisions SET reviewed_by = 'other' WHERE id = 'issue-50-canonical-jump-trading'").run())
      .toThrow('admission reviewer decisions are immutable');
    expect(() => database.prepare("DELETE FROM admission_reviewer_decisions WHERE id = 'issue-50-canonical-jump-trading'").run())
      .toThrow('admission reviewer decisions are immutable');
    database.close();
  });

  it.each([
    ['canonical employer', (database: DatabaseSync) => database.prepare(`INSERT INTO canonical_employers
      (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES ('jump-trading', 'Wrong Existing Name', '2026-01-01T00:00:00Z', 'older-review', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run()],
    ['employer mapping', (database: DatabaseSync) => database.exec(`
      INSERT INTO canonical_employers
        (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
        VALUES ('jump-trading', 'Jump Trading', '2026-08-30T00:00:00Z', 'issue-50-production-review',
          '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');
      INSERT INTO employer_mappings
        (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
        VALUES ('issue-50-github-employer-jump-trading', 'github', 'employer:wrong', 'jump-trading',
          '2026-01-01T00:00:00Z', 'older-review', '2026-01-01T00:00:00Z');
    `)],
    ['reviewer decision', (database: DatabaseSync) => database.prepare(`INSERT INTO admission_reviewer_decisions
      (id, subject_type, subject_id, decision, reason, reviewed_at, reviewed_by)
      VALUES ('issue-50-canonical-jump-trading', 'canonical-employer', 'jump-trading', 'rejected', 'Older decision',
        '2026-01-01T00:00:00Z', 'older-review')`).run()],
  ])('fails instead of approving a conflicting existing %s', (_label, seedConflict) => {
    const database = databaseThrough0010();
    seedConflict(database);

    expect(() => database.exec(migration)).toThrow('issue_50_reviewed_identity_rows_must_match');
    expect(database.prepare("SELECT COUNT(*) AS count FROM admission_reviewer_decisions WHERE reviewed_by = 'issue-50-production-review'").get())
      .toEqual({ count: 0 });
    database.close();
  });
});
