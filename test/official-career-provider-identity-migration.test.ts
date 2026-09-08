import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../cloudflare/migrations/', import.meta.url);
const through0011 = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql') && name.localeCompare('0012') < 0)
  .sort();
const migration = readFileSync(new URL('0012_official_career_provider_identity.sql', migrations), 'utf8');

function databaseThrough0011(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const name of through0011) database.exec(readFileSync(new URL(name, migrations), 'utf8'));
  return database;
}

describe('official career provider identity migration', () => {
  it('is idempotent and removes its temporary assertion table', () => {
    const database = databaseThrough0011();
    database.exec(migration);
    database.exec(migration);

    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_employers WHERE reviewed_by = 'official-career-route-review'").get())
      .toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM employer_mappings WHERE reviewed_by = 'official-career-route-review'").get())
      .toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM admission_reviewer_decisions WHERE reviewed_by = 'official-career-route-review'").get())
      .toEqual({ count: 10 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_0012_official_provider_assertion'").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it.each([
    ['canonical employer', (database: DatabaseSync) => database.prepare(`INSERT INTO canonical_employers
      (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES ('meta', 'Wrong Existing Name', '2026-01-01T00:00:00Z', 'older-review',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run()],
    ['employer mapping', (database: DatabaseSync) => database.exec(`
      INSERT INTO canonical_employers
        (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
        VALUES ('meta', 'Meta', '2026-09-01T00:00:00Z', 'official-career-route-review',
          '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
      INSERT INTO employer_mappings
        (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
        VALUES ('official-career-provider-meta', 'github', 'employer:meta', 'meta',
          '2026-01-01T00:00:00Z', 'older-review', '2026-01-01T00:00:00Z');
    `)],
    ['reviewer decision', (database: DatabaseSync) => database.prepare(`INSERT INTO admission_reviewer_decisions
      (id, subject_type, subject_id, decision, reason, reviewed_at, reviewed_by)
      VALUES ('official-career-canonical-meta', 'canonical-employer', 'meta', 'rejected', 'Older rejection',
        '2026-01-01T00:00:00Z', 'older-review')`).run()],
  ])('fails instead of retaining a conflicting existing %s', (_label, seedConflict) => {
    const database = databaseThrough0011();
    seedConflict(database);

    expect(() => database.exec(migration)).toThrow('official_provider_rows_must_match');
    expect(database.prepare("SELECT COUNT(*) AS count FROM admission_reviewer_decisions WHERE reviewed_by = 'official-career-route-review'").get())
      .toEqual({ count: 0 });
    database.close();
  });
});
