import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../cloudflare/migrations/0013_posting_presentation_reviews.sql',
  import.meta.url,
), 'utf8');

describe('posting presentation review migration', () => {
  it('records the two exact official-page reviews as immutable decisions', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(migration);

    expect(database.prepare(`SELECT provider, tenant, posting_id, company, title, location, apply_url
      FROM posting_identity_presentation_reviews ORDER BY provider`).all()).toEqual([
      {
        provider: 'goldman-sachs', tenant: 'goldman-sachs', posting_id: '171567', company: 'Goldman Sachs',
        title: '2027 | Americas | Toronto | Engineering | Summer Analyst', location: 'Toronto, ON, Canada',
        apply_url: 'https://higher.gs.com/roles/171567',
      },
      {
        provider: 'meta', tenant: 'meta', posting_id: '1027438186737957', company: 'Meta',
        title: 'Research Scientist Intern, AI, Cyber Security, Safety — MSL Trust & Safety (PhD)',
        location: 'Menlo Park, CA', apply_url: 'https://www.metacareers.com/jobs/1027438186737957',
      },
    ]);
    expect(() => database.exec("UPDATE posting_identity_presentation_reviews SET title = 'Wrong' WHERE provider = 'meta'"))
      .toThrow('posting identity presentation reviews are immutable');
    expect(() => database.exec("DELETE FROM posting_identity_presentation_reviews WHERE provider = 'meta'"))
      .toThrow('posting identity presentation reviews are immutable');
    database.close();
  });
});
