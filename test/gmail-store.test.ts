import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { decryptGmailToken, encryptGmailToken, gmailApi, gmailCallback, GmailStore, type GmailEnvironment } from '../cloudflare/gmail.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return { prepare: (query) => prepared(query), batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) };
}

function database() {
  const value = new DatabaseSync(':memory:');
  value.exec(`CREATE TABLE user_items (user_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, item_key));`);
  value.exec(readFileSync(new URL('../cloudflare/migrations/0006_gmail_detection.sql', import.meta.url), 'utf8'));
  return value;
}

describe('Gmail credential and state storage', () => {
  it('encrypts refresh tokens with authenticated encryption', async () => {
    const envelope = await encryptGmailToken('refresh-token', 'independent-encryption-secret');
    expect(envelope).not.toContain('refresh-token');
    await expect(decryptGmailToken(envelope, 'independent-encryption-secret')).resolves.toBe('refresh-token');
    await expect(decryptGmailToken(envelope, 'different-secret')).rejects.toThrow();
  });

  it('consumes OAuth state once and rejects expired state', async () => {
    const db = database(); const store = new GmailStore(sqliteD1(db)); const now = new Date('2026-08-26T12:00:00.000Z');
    await store.putOAuthState('state-one', 'user-1', 'verifier', now);
    await expect(store.consumeOAuthState('state-one', now)).resolves.toMatchObject({ user_id: 'user-1', code_verifier: 'verifier' });
    await expect(store.consumeOAuthState('state-one', now)).resolves.toBeUndefined();
    await store.putOAuthState('expired', 'user-1', 'verifier', new Date('2026-08-26T11:00:00.000Z'));
    await expect(store.consumeOAuthState('expired', now)).resolves.toBeUndefined();
    db.close();
  });

  it('disconnects all Gmail data while preserving status and applied timestamp', async () => {
    const db = database(); const store = new GmailStore(sqliteD1(db)); const now = new Date('2026-08-26T12:00:00.000Z');
    await store.connect('user-1', 'student@example.com', 'encrypted', now);
    await store.markProcessed('user-1', 'message-hmac', now);
    await store.addDetection('user-1', 'message-hmac', { sender: 'jobs@example.com', subject: 'Application received', receivedAt: now.toISOString(), labels: ['INBOX'] }, [{ jobId: 'job-1', company: 'Example', title: 'SWE Intern', signals: ['employer'] }], ['review'], now);
    db.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, 'application', ?)")
      .run('user-1', 'APPLICATION#one', JSON.stringify({ applicationId: 'one', jobId: 'job-1', status: 'applied', appliedAt: now.toISOString(), detection: { source: 'gmail', detectedAt: now.toISOString() } }));

    await store.disconnectLocal('user-1');

    await expect(store.status('user-1')).resolves.toEqual({ connected: false });
    await expect(store.detections('user-1')).resolves.toEqual([]);
    const application = JSON.parse((db.prepare('SELECT value FROM user_items WHERE user_id = ?').get('user-1') as { value: string }).value) as Record<string, unknown>;
    expect(application).toMatchObject({ status: 'applied', appliedAt: now.toISOString() });
    expect(application).not.toHaveProperty('detection');
    db.close();
  });

  it('starts PKCE OAuth, encrypts the grant, queues initial sync, and rejects callback replay', async () => {
    const db = database(); const send = vi.fn(async () => undefined);
    const env: GmailEnvironment = {
      DB: sqliteD1(db), GMAIL_QUEUE: { send, async sendBatch() {} }, PUBLIC_API_URL: 'https://api.example.test', GMAIL_ENABLED: 'true',
      GMAIL_CLIENT_ID: 'client-id', GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_TOKEN_ENCRYPTION_KEY: 'encryption-key-with-at-least-32-characters',
      GMAIL_MESSAGE_HMAC_KEY: 'message-hmac-key-with-at-least-32-characters',
    };
    const started = await gmailApi(new Request('https://api.example.test/me/gmail/authorization', { method: 'POST' }), env, 'user-1');
    expect(started?.status).toBe(200);
    const { authorizationUrl } = await started!.json() as { authorizationUrl: string };
    const authorization = new URL(authorizationUrl); const state = authorization.searchParams.get('state');
    expect(authorization.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.metadata');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state).toBeTruthy();
    expect(db.prepare('SELECT state_hash FROM gmail_oauth_states').get()).not.toMatchObject({ state_hash: state });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token' });
      if (url.endsWith('/gmail/v1/users/me/profile')) return Response.json({ emailAddress: 'student@example.com', historyId: 'history-1' });
      throw new Error(`Unexpected request ${url}`);
    });
    const callbackUrl = `https://api.example.test/oauth/gmail/callback?code=authorization-code&state=${encodeURIComponent(state!)}`;
    const callback = await gmailCallback(new Request(callbackUrl), env);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toContain('status=connected');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', mode: 'initial' }));
    const connection = db.prepare('SELECT email, refresh_token FROM gmail_connections').get() as { email: string; refresh_token: string };
    expect(connection.email).toBe('student@example.com');
    expect(connection.refresh_token).not.toContain('refresh-token');

    const replay = await gmailCallback(new Request(callbackUrl), env);
    expect(replay.headers.get('Location')).toContain('status=error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore(); db.close();
  });
});
