import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const initial = readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../cloudflare/migrations/0014_catalog_admission_indexes.sql', import.meta.url), 'utf8');

describe('catalog admission index migration', () => {
  it('removes ineligible roles from browse and delivery indexes without hiding eligible roles', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(initial);
    const insert = database.prepare(`INSERT INTO catalog_items
      (pk, sk, kind, value, sms_pending, digest_pending, catalog_state, catalog_sort_key, search_text, source_classes)
      VALUES (?, 'META', 'internship', ?, 1, 1, 'OPEN', 'sort', 'search', '["direct"]')`);
    insert.run('JOB#rejected', JSON.stringify({ admission: { catalogEligible: false, alertEligible: false } }));
    insert.run('JOB#grace', JSON.stringify({ admission: { catalogEligible: true, alertEligible: false } }));
    insert.run('JOB#eligible', JSON.stringify({ admission: { catalogEligible: true, alertEligible: true } }));

    database.exec(migration);
    database.exec(migration);

    const rows = database.prepare(`SELECT pk, sms_pending, digest_pending, catalog_state, catalog_sort_key, search_text, source_classes
      FROM catalog_items WHERE kind = 'internship' ORDER BY pk`).all();
    expect(rows).toEqual([
      { pk: 'JOB#eligible', sms_pending: 1, digest_pending: 1, catalog_state: 'OPEN', catalog_sort_key: 'sort', search_text: 'search', source_classes: '["direct"]' },
      { pk: 'JOB#grace', sms_pending: 0, digest_pending: 0, catalog_state: 'OPEN', catalog_sort_key: 'sort', search_text: 'search', source_classes: '["direct"]' },
      { pk: 'JOB#rejected', sms_pending: 0, digest_pending: 0, catalog_state: null, catalog_sort_key: null, search_text: null, source_classes: null },
    ]);
    database.close();
  });
});
