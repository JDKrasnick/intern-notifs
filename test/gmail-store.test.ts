import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { decryptGmailToken, encryptGmailToken, gmailApi, gmailCallback, GmailStore, processGmailWork, recordGmailFailure, type GmailEnvironment, type GmailWorkMessage } from '../cloudflare/gmail.js';
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
  value.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  value.exec(readFileSync(new URL('../cloudflare/migrations/0006_gmail_detection.sql', import.meta.url), 'utf8'));
  value.exec(readFileSync(new URL('../cloudflare/migrations/0007_gmail_application_checks.sql', import.meta.url), 'utf8'));
  return value;
}

function role() {
  return {
    jobId: 'job-1', company: 'Northstar Labs', title: 'Software Engineering Intern', location: 'New York', season: 'Summer 2027',
    applyUrl: 'https://boards.greenhouse.io/northstar/jobs/12345', normalizedUrl: 'https://boards.greenhouse.io/northstar/jobs/12345',
    fingerprint: 'fingerprint', technical: true, open: true, firstSeenAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-08-25T00:00:00.000Z',
    compensation: { raw: 'Not listed' }, sourceReferences: [], notification: { smsPending: false, digestPending: false },
    postingIdentity: { provider: 'greenhouse', tenant: 'northstar', providerPostingId: '12345', canonicalApplicationUrl: 'https://boards.greenhouse.io/northstar/jobs/12345', canonicalJobId: 'job-1', aliases: [] },
  };
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

  it('schedules exactly four checks at 5 minutes, 10 minutes, 30 minutes, and 24 hours', async () => {
    const db = database(); const store = new GmailStore(sqliteD1(db)); const clickedAt = new Date('2026-08-26T12:00:00.000Z');
    await store.connect('user-1', 'student@example.com', 'encrypted', clickedAt);
    await store.scheduleCheck('user-1', 'job-1', clickedAt);

    const expected = ['2026-08-26T12:05:00.000Z', '2026-08-26T12:10:00.000Z', '2026-08-26T12:30:00.000Z'];
    for (let attempt = 0; attempt < expected.length; attempt += 1) {
      const check = await store.check('user-1', 'job-1');
      expect(check).toMatchObject({ attempt_index: attempt, next_check_at: expected[attempt], status: 'pending' });
      await expect(store.due(new Date(expected[attempt]!))).resolves.toEqual(['user-1']);
      await store.advanceDueChecks('user-1', new Date(expected[attempt]!), new Date(expected[attempt]!));
    }
    await expect(store.check('user-1', 'job-1')).resolves.toMatchObject({
      attempt_index: 3, next_check_at: '2026-08-27T12:00:00.000Z', status: 'pending',
    });
    await store.advanceDueChecks('user-1', new Date('2026-08-27T12:00:00.000Z'), new Date('2026-08-27T12:00:00.000Z'));
    await expect(store.check('user-1', 'job-1')).resolves.toMatchObject({ attempt_index: 4, next_check_at: null, status: 'expired' });
    db.close();
  });

  it('accepts an Apply-click check before Gmail is connected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    const db = database();
    db.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'META', 'internship', ?)")
      .run('JOB#job-1', JSON.stringify(role()));
    const send = vi.fn<(message: unknown, options?: { delaySeconds?: number }) => Promise<void>>(async () => undefined);
    const env = {
      DB: sqliteD1(db), GMAIL_QUEUE: { send, async sendBatch() {} }, PUBLIC_API_URL: 'https://api.example.test', GMAIL_ENABLED: 'true',
      GMAIL_CLIENT_ID: 'client-id', GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_TOKEN_ENCRYPTION_KEY: 'encryption-key-with-at-least-32-characters',
      GMAIL_MESSAGE_HMAC_KEY: 'message-hmac-key-with-at-least-32-characters',
    } satisfies GmailEnvironment;

    const response = await gmailApi(new Request('https://api.example.test/me/gmail/checks', {
      method: 'POST', body: JSON.stringify({ jobId: 'job-1' }),
    }), env, 'user-1');
    expect(response?.status).toBe(202);
    await expect(response?.json()).resolves.toMatchObject({
      scheduled: true, gmailConnected: false,
      checksAt: ['2026-08-26T12:05:00.000Z', '2026-08-26T12:10:00.000Z', '2026-08-26T12:30:00.000Z', '2026-08-27T12:00:00.000Z'],
    });
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      { delaySeconds: 300 }, { delaySeconds: 600 }, { delaySeconds: 1800 }, { delaySeconds: 86400 },
    ]);
    vi.useRealTimers(); db.close();
  });

  it('disconnects all Gmail data while preserving status and applied timestamp', async () => {
    const db = database(); const store = new GmailStore(sqliteD1(db)); const now = new Date('2026-08-26T12:00:00.000Z');
    await store.connect('user-1', 'student@example.com', 'encrypted', now);
    await store.scheduleCheck('user-1', 'job-1', now);
    await store.markProcessed('user-1', 'message-hmac', now);
    await store.addDetection('user-1', 'message-hmac', { sender: 'jobs@example.com', subject: 'Application received', receivedAt: now.toISOString(), labels: ['INBOX'] }, [{ jobId: 'job-1', company: 'Example', title: 'SWE Intern', signals: ['employer'] }], ['review'], now);
    db.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, 'application', ?)")
      .run('user-1', 'APPLICATION#one', JSON.stringify({ applicationId: 'one', jobId: 'job-1', status: 'applied', appliedAt: now.toISOString(), detection: { source: 'gmail', detectedAt: now.toISOString() } }));

    await store.disconnectLocal('user-1');

    await expect(store.status('user-1')).resolves.toEqual({ connected: false });
    await expect(store.detections('user-1')).resolves.toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gmail_application_checks').get()).toMatchObject({ count: 0 });
    const application = JSON.parse((db.prepare('SELECT value FROM user_items WHERE user_id = ?').get('user-1') as { value: string }).value) as Record<string, unknown>;
    expect(application).toMatchObject({ status: 'applied', appliedAt: now.toISOString() });
    expect(application).not.toHaveProperty('detection');
    db.close();
  });

  it('starts PKCE OAuth, encrypts the grant, queues initial sync, and rejects callback replay', async () => {
    const db = database(); const send = vi.fn<(message: unknown) => Promise<void>>(async () => undefined);
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

  it('replays history from before the initial scan so mail arriving during the scan is applied', async () => {
    const db = database(); const send = vi.fn<(message: unknown) => Promise<void>>(async () => undefined); const now = new Date('2026-08-26T12:00:00.000Z');
    const env: GmailEnvironment = {
      DB: sqliteD1(db), GMAIL_QUEUE: { send, async sendBatch() {} }, PUBLIC_API_URL: 'https://api.example.test', GMAIL_ENABLED: 'true',
      GMAIL_CLIENT_ID: 'client-id', GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_TOKEN_ENCRYPTION_KEY: 'encryption-key-with-at-least-32-characters',
      GMAIL_MESSAGE_HMAC_KEY: 'message-hmac-key-with-at-least-32-characters',
    };
    const store = new GmailStore(env.DB);
    await store.connect('user-1', 'student@example.com', await encryptGmailToken('refresh-token', env.GMAIL_TOKEN_ENCRYPTION_KEY!), now);
    db.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'META', 'internship', ?)")
      .run('JOB#job-1', JSON.stringify(role()));
    await store.scheduleCheck('user-1', 'job-1', new Date(now.getTime() - 5 * 60_000));
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input); requests.push(url);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token' });
      if (url.endsWith('/gmail/v1/users/me/profile')) return Response.json({ emailAddress: 'student@example.com', historyId: 'history-before-scan' });
      if (url.includes('/gmail/v1/users/me/messages?')) return Response.json({ messages: [] });
      if (url.includes('/gmail/v1/users/me/history?')) return Response.json({
        history: [{ messagesAdded: [{ message: { id: 'vanished-message' } }, { message: { id: 'arrived-during-scan' } }] }], historyId: 'history-after-scan',
      });
      if (url.includes('/gmail/v1/users/me/messages/vanished-message?')) return Response.json(
        { error: { status: 'NOT_FOUND' } }, { status: 404 },
      );
      if (url.includes('/gmail/v1/users/me/messages/arrived-during-scan?')) return Response.json({
        id: 'arrived-during-scan', internalDate: String(now.getTime()), labelIds: ['INBOX'],
        payload: { headers: [
          { name: 'From', value: 'Northstar Recruiting <notifications@greenhouse-mail.io>' },
          { name: 'Subject', value: 'Thank you for applying to Software Engineering Intern at Northstar Labs' },
        ] },
      });
      throw new Error(`Unexpected request ${url}`);
    });

    await processGmailWork({ version: 1, userId: 'user-1', mode: 'initial', requestedAt: now.toISOString() }, env, now);
    expect(requests.findIndex((url) => url.endsWith('/profile'))).toBeLessThan(requests.findIndex((url) => url.includes('/messages?')));
    const catchup = send.mock.calls[0]?.[0] as GmailWorkMessage;
    expect(catchup).toMatchObject({ mode: 'history', startHistoryId: 'history-before-scan' });
    await processGmailWork(catchup, env, new Date(now.getTime() + 1));

    const application = db.prepare("SELECT value FROM user_items WHERE user_id = ? AND kind = 'application'").get('user-1') as { value: string };
    expect(JSON.parse(application.value)).toMatchObject({ jobId: 'job-1', status: 'applied', detection: { source: 'gmail' } });
    await expect(store.check('user-1', 'job-1')).resolves.toMatchObject({ status: 'detected', next_check_at: null });
    await expect(store.status('user-1')).resolves.toMatchObject({ connected: true, state: 'connected' });
    fetchMock.mockRestore(); db.close();
  });

  it('establishes a history cursor without reading inbox messages before the first Apply check is due', async () => {
    const db = database(); const now = new Date('2026-08-26T12:00:00.000Z');
    const env: GmailEnvironment = {
      DB: sqliteD1(db), GMAIL_QUEUE: { async send() {}, async sendBatch() {} }, PUBLIC_API_URL: 'https://api.example.test', GMAIL_ENABLED: 'true',
      GMAIL_CLIENT_ID: 'client-id', GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_TOKEN_ENCRYPTION_KEY: 'encryption-key-with-at-least-32-characters',
      GMAIL_MESSAGE_HMAC_KEY: 'message-hmac-key-with-at-least-32-characters',
    };
    const store = new GmailStore(env.DB);
    await store.connect('user-1', 'student@example.com', await encryptGmailToken('refresh-token', env.GMAIL_TOKEN_ENCRYPTION_KEY!), now);
    await store.scheduleCheck('user-1', 'job-1', now);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token' });
      if (url.endsWith('/gmail/v1/users/me/profile')) return Response.json({ emailAddress: 'student@example.com', historyId: 'cursor-1' });
      throw new Error(`Inbox should not be read without an Apply check: ${url}`);
    });

    await processGmailWork({ version: 1, userId: 'user-1', mode: 'initial', requestedAt: now.toISOString() }, env, now);
    await expect(store.status('user-1')).resolves.toMatchObject({ connected: true, state: 'connected' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore(); db.close();
  });

  it('records a revoked grant as terminal and excludes it from scheduled sync', async () => {
    const db = database(); const now = new Date('2026-08-26T12:00:00.000Z');
    const env = { DB: sqliteD1(db) } as GmailEnvironment; const store = new GmailStore(env.DB);
    await store.connect('user-1', 'student@example.com', 'encrypted', now);
    await store.scheduleCheck('user-1', 'job-1', now);
    const error = Object.assign(new Error('revoked'), { status: 401 });

    await expect(recordGmailFailure('user-1', error, env, now)).resolves.toMatchObject({ retry: false });
    await expect(store.status('user-1')).resolves.toMatchObject({ connected: true, state: 'error', error: { retryable: false } });
    await expect(store.due(new Date(now.getTime() + 24 * 60 * 60_000))).resolves.toEqual([]);
    db.close();
  });
});
