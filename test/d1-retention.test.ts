import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { cleanupExpiredUserData } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

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
    async batch(statements: D1PreparedStatement[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

describe('D1 user-data retention', () => {
  it('removes inactive installations and expired short-lived records while backfilling legacy expiry', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE user_items (
        user_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        expires_at INTEGER, PRIMARY KEY (user_id, item_key)
      );
    `);
    const insert = database.prepare('INSERT INTO user_items (user_id, item_key, kind, value, expires_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date('2026-08-25T12:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    insert.run('installation:expired', 'INSTALLATION', 'installation', JSON.stringify({ createdAt: '2025-01-01T00:00:00.000Z' }), nowSeconds - 1);
    insert.run('installation:expired', 'PREFERENCES', 'preferences', '{}', null);
    insert.run('installation:active', 'INSTALLATION', 'installation', JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }), nowSeconds + 1000);
    insert.run('installation:legacy', 'INSTALLATION', 'installation', JSON.stringify({ createdAt: '2025-01-01T00:00:00.000Z' }), null);
    insert.run('installation:active', 'RECEIPT#old', 'receipt', JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }), null);
    insert.run('installation:active', 'RECEIPT#recent', 'receipt', JSON.stringify({ updatedAt: '2026-08-20T00:00:00.000Z' }), null);
    insert.run('account-user', 'APPLICATION_SESSION#expired', 'application-session', '{}', nowSeconds - 1);

    await cleanupExpiredUserData(sqliteD1(database), now);

    expect(database.prepare('SELECT item_key FROM user_items WHERE user_id = ?').all('installation:expired')).toEqual([]);
    expect(database.prepare('SELECT item_key FROM user_items WHERE user_id = ? ORDER BY item_key').all('installation:active'))
      .toEqual([{ item_key: 'INSTALLATION' }, { item_key: 'RECEIPT#recent' }]);
    const legacy = database.prepare('SELECT expires_at FROM user_items WHERE user_id = ?').get('installation:legacy') as { expires_at: number };
    expect(legacy.expires_at).toBe(nowSeconds + 365 * 24 * 60 * 60);
    expect(database.prepare('SELECT item_key FROM user_items WHERE user_id = ?').all('account-user')).toEqual([]);
    database.close();
  });
});
