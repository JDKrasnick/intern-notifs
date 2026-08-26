import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { authenticatedInstallation, createInstallation } from '../cloudflare/auth.js';
import type { AuthEnvironment } from '../cloudflare/auth.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import worker, { type Environment } from '../cloudflare/worker.js';

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

describe('account-independent installation authorization', () => {
  it('creates an anonymous preference owner and authenticates only its opaque token', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_items (
        user_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        session_id TEXT, PRIMARY KEY (user_id, item_key)
      );
      CREATE UNIQUE INDEX user_items_session_id ON user_items(session_id) WHERE session_id IS NOT NULL;
    `);
    const env = {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      PUBLIC_API_URL: 'https://example.test',
      DB: sqliteD1(database),
    } as AuthEnvironment;

    const installation = await createInstallation(env);
    expect(installation.userId).toMatch(/^installation:/u);
    const preferences = database.prepare("SELECT value FROM user_items WHERE user_id = ? AND item_key = 'PREFERENCES'")
      .get(installation.userId) as { value: string };
    expect(JSON.parse(preferences.value)).toMatchObject({
      userId: installation.userId,
      alertsEnabled: false,
      onboardingComplete: true,
    });
    await expect(authenticatedInstallation(new Request('https://example.test/installation/preferences', {
      headers: { Authorization: `Bearer ${installation.token}` },
    }), env)).resolves.toBe(installation.userId);
    await expect(authenticatedInstallation(new Request('https://example.test/installation/preferences', {
      headers: { Authorization: 'Bearer invalid-token' },
    }), env)).resolves.toBeUndefined();
    database.close();
  });

  it('serves preferences through the installation boundary but not account data', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_items (
        user_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        active_device INTEGER NOT NULL DEFAULT 0, device_token TEXT, receipt_state TEXT,
        session_id TEXT, expires_at INTEGER, PRIMARY KEY (user_id, item_key)
      );
      CREATE UNIQUE INDEX user_items_session_id ON user_items(session_id) WHERE session_id IS NOT NULL;
    `);
    const env = {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      PUBLIC_API_URL: 'https://example.test',
      DB: sqliteD1(database),
    } as Environment;
    const created = await worker.fetch(new Request('https://example.test/installations', { method: 'POST' }), env);
    expect(created.status).toBe(201);
    const { token, userId } = await created.json() as { token: string; userId: string };
    const headers = { Authorization: `Bearer ${token}` };

    const preferences = await worker.fetch(new Request('https://example.test/installation/preferences', { headers }), env);
    expect(preferences.status).toBe(200);
    await expect(preferences.json()).resolves.toMatchObject({ alertsEnabled: false, onboardingComplete: true });

    const deviceToken = 'ExponentPushToken[physical-device]';
    const legacyDevice = {
      userId: 'account-user', token: deviceToken, platform: 'ios', active: true,
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    };
    database.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, active_device, device_token)
      VALUES (?, ?, 'device', ?, 1, ?)
    `).run(legacyDevice.userId, `DEVICE#${deviceToken}`, JSON.stringify(legacyDevice), deviceToken);
    const registered = await worker.fetch(new Request('https://example.test/installation/devices', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: deviceToken, platform: 'ios' }),
    }), env);
    expect(registered.status).toBe(201);
    expect(database.prepare("SELECT user_id FROM user_items WHERE kind = 'device' AND device_token = ?").all(deviceToken))
      .toEqual([{ user_id: userId }]);

    const profile = await worker.fetch(new Request('https://example.test/installation/profile', { headers }), env);
    expect(profile.status).toBe(404);
    database.close();
  });
});
