import { matchGmailApplication, type GmailDetectionCandidate, type GmailMetadata } from '../src/gmail-matcher.js';
import type { ApplicationRecord, Internship } from '../src/types.js';
import type { D1Database, Queue } from './types.js';
import { D1InternshipStore, D1UserStore } from './d1-store.js';

const gmailScope = 'https://www.googleapis.com/auth/gmail.metadata';
const oauthStateLifetimeMs = 10 * 60_000;
const pendingLifetimeMs = 30 * 24 * 60 * 60_000;
const processedLifetimeMs = 180 * 24 * 60 * 60_000;
const leaseLifetimeMs = 5 * 60_000;
const initialLookbackMs = 30 * 24 * 60 * 60_000;
const terminalApplicationStatuses = new Set(['assessment', 'interview', 'offer', 'rejected', 'withdrawn']);

export interface GmailEnvironment {
  DB: D1Database;
  GMAIL_QUEUE: Queue;
  PUBLIC_API_URL: string;
  GMAIL_ENABLED?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  GMAIL_MESSAGE_HMAC_KEY?: string;
  GMAIL_REDIRECT_URI?: string;
}

export interface GmailConnectionStatus {
  connected: boolean;
  email?: string;
  state?: 'syncing' | 'connected' | 'error';
  lastSuccessfulSync?: string;
  error?: { retryable: boolean; message: string };
}

interface ConnectionRow {
  user_id: string;
  email: string;
  refresh_token: string;
  history_id: string | null;
  sync_state: string;
  last_success_at: string | null;
  next_sync_at: string;
  lease_until: string | null;
  retry_count: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface OAuthStateRow { state_hash: string; user_id: string; code_verifier: string; expires_at: string; }
interface DetectionRow {
  detection_id: string;
  user_id: string;
  message_date: string;
  sender: string;
  subject: string;
  candidates: string;
  reasons: string;
  created_at: string;
  expires_at: string;
}

interface GoogleTokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string; }
interface GmailProfile { emailAddress: string; historyId: string; }
interface GmailMessageList { messages?: Array<{ id: string }>; nextPageToken?: string; }
interface GmailHistoryList { history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; nextPageToken?: string; historyId?: string; }
interface GmailMessage {
  id: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }> };
}

export interface GmailWorkMessage {
  version: 1;
  userId: string;
  mode: 'initial' | 'history';
  pageToken?: string;
  requestedAt: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength); copy.set(value); return copy.buffer;
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

async function stateHash(state: string): Promise<string> { return base64Url(new Uint8Array(await digest(state))); }

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await digest(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptGmailToken(token: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), new TextEncoder().encode(token)));
  return `v1.${base64Url(iv)}.${base64Url(ciphertext)}`;
}

export async function decryptGmailToken(value: string, secret: string): Promise<string> {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Gmail credential envelope is invalid');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(fromBase64Url(iv)) }, await encryptionKey(secret), arrayBuffer(fromBase64Url(ciphertext)));
  return new TextDecoder().decode(plaintext);
}

function requireGmailConfig(env: GmailEnvironment) {
  if (env.GMAIL_ENABLED !== 'true') throw new Error('Gmail application detection is not enabled');
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_TOKEN_ENCRYPTION_KEY || !env.GMAIL_MESSAGE_HMAC_KEY) {
    throw new Error('Gmail application detection is not configured');
  }
  if (env.GMAIL_TOKEN_ENCRYPTION_KEY.length < 32 || env.GMAIL_MESSAGE_HMAC_KEY.length < 32) throw new Error('Gmail cryptographic keys must contain at least 32 characters');
  return {
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    encryptionSecret: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    messageSecret: env.GMAIL_MESSAGE_HMAC_KEY,
    redirectUri: env.GMAIL_REDIRECT_URI ?? `${env.PUBLIC_API_URL.replace(/\/$/u, '')}/oauth/gmail/callback`,
  };
}

function userMessage(code: string | null): string {
  if (code === 'revoked') return 'Gmail access was revoked. Connect Gmail again.';
  if (code === 'rate_limited') return 'Gmail is temporarily limiting syncs. Try again later.';
  return 'Gmail could not be checked. Try syncing again.';
}

export class GmailStore {
  constructor(private readonly db: D1Database) {}

  async status(userId: string): Promise<GmailConnectionStatus> {
    const row = await this.connection(userId);
    if (!row) return { connected: false };
    return {
      connected: true,
      email: row.email,
      state: row.sync_state === 'error' ? 'error' : row.history_id ? 'connected' : 'syncing',
      ...(row.last_success_at ? { lastSuccessfulSync: row.last_success_at } : {}),
      ...(row.error_code ? { error: { retryable: row.error_code !== 'revoked', message: userMessage(row.error_code) } } : {}),
    };
  }

  connection(userId: string) {
    return this.db.prepare('SELECT * FROM gmail_connections WHERE user_id = ?').bind(userId).first<ConnectionRow>().then((row) => row ?? undefined);
  }

  async putOAuthState(state: string, userId: string, verifier: string, now: Date): Promise<void> {
    await this.db.prepare('INSERT INTO gmail_oauth_states (state_hash, user_id, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await stateHash(state), userId, verifier, new Date(now.getTime() + oauthStateLifetimeMs).toISOString(), now.toISOString()).run();
  }

  async consumeOAuthState(state: string, now: Date): Promise<OAuthStateRow | undefined> {
    const hash = await stateHash(state);
    const row = await this.db.prepare('SELECT state_hash, user_id, code_verifier, expires_at FROM gmail_oauth_states WHERE state_hash = ? AND expires_at > ?')
      .bind(hash, now.toISOString()).first<OAuthStateRow>();
    if (!row) return undefined;
    const removed = await this.db.prepare('DELETE FROM gmail_oauth_states WHERE state_hash = ?').bind(hash).run();
    return removed.meta.changes === 1 ? row : undefined;
  }

  async connect(userId: string, email: string, encryptedRefreshToken: string, now: Date): Promise<void> {
    await this.db.prepare(`
      INSERT INTO gmail_connections (user_id, email, refresh_token, sync_state, next_sync_at, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, 'syncing', ?, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token,
        history_id = NULL, sync_state = 'syncing', next_sync_at = excluded.next_sync_at,
        lease_until = NULL, retry_count = 0, error_code = NULL, updated_at = excluded.updated_at
    `).bind(userId, email.toLowerCase(), encryptedRefreshToken, now.toISOString(), now.toISOString(), now.toISOString()).run();
  }

  async updateRefreshToken(userId: string, encryptedRefreshToken: string, now: Date): Promise<void> {
    await this.db.prepare('UPDATE gmail_connections SET refresh_token = ?, updated_at = ? WHERE user_id = ?')
      .bind(encryptedRefreshToken, now.toISOString(), userId).run();
  }

  async due(now: Date, limit = 100): Promise<string[]> {
    const rows = await this.db.prepare(`SELECT user_id FROM gmail_connections WHERE next_sync_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY next_sync_at LIMIT ?`)
      .bind(now.toISOString(), now.toISOString(), limit).all<{ user_id: string }>();
    return rows.results.map((row) => row.user_id);
  }

  async claimLease(userId: string, now: Date): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE gmail_connections SET lease_until = ?, updated_at = ? WHERE user_id = ? AND (lease_until IS NULL OR lease_until <= ?)`)
      .bind(new Date(now.getTime() + leaseLifetimeMs).toISOString(), now.toISOString(), userId, now.toISOString()).run();
    return result.meta.changes === 1;
  }

  async synced(userId: string, historyId: string, now: Date): Promise<void> {
    await this.db.prepare(`UPDATE gmail_connections SET history_id = ?, sync_state = 'connected', last_success_at = ?, next_sync_at = ?, lease_until = NULL, retry_count = 0, error_code = NULL, updated_at = ? WHERE user_id = ?`)
      .bind(historyId, now.toISOString(), new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString(), userId).run();
  }

  async continued(userId: string, now: Date): Promise<void> {
    await this.db.prepare('UPDATE gmail_connections SET lease_until = NULL, updated_at = ? WHERE user_id = ?').bind(now.toISOString(), userId).run();
  }

  async failed(userId: string, code: string, now: Date): Promise<number> {
    const row = await this.connection(userId);
    const retryCount = (row?.retry_count ?? 0) + 1;
    const delayMinutes = Math.min(360, 2 ** Math.min(retryCount, 8));
    await this.db.prepare(`UPDATE gmail_connections SET sync_state = 'error', error_code = ?, retry_count = ?, next_sync_at = ?, lease_until = NULL, updated_at = ? WHERE user_id = ?`)
      .bind(code, retryCount, new Date(now.getTime() + delayMinutes * 60_000).toISOString(), now.toISOString(), userId).run();
    return Math.min(delayMinutes * 60, 12 * 60 * 60);
  }

  async processed(userId: string, messageKey: string): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT 1 AS found FROM gmail_processed_messages WHERE user_id = ? AND message_key = ?')
      .bind(userId, messageKey).first<{ found: number }>());
  }

  async markProcessed(userId: string, messageKey: string, now: Date): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO gmail_processed_messages (user_id, message_key, processed_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(userId, messageKey, now.toISOString(), new Date(now.getTime() + processedLifetimeMs).toISOString()).run();
  }

  async addDetection(userId: string, messageKey: string, metadata: GmailMetadata, candidates: GmailDetectionCandidate[], reasons: string[], now: Date): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO gmail_detections (detection_id, user_id, message_key, message_date, sender, subject, candidates, reasons, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, messageKey, metadata.receivedAt, metadata.sender.slice(0, 320), metadata.subject.slice(0, 500), JSON.stringify(candidates), JSON.stringify(reasons), now.toISOString(), new Date(now.getTime() + pendingLifetimeMs).toISOString()).run();
  }

  async detections(userId: string): Promise<Array<{ detectionId: string; receivedAt: string; sender: string; subject: string; candidates: GmailDetectionCandidate[]; reasons: string[] }>> {
    const rows = await this.db.prepare('SELECT * FROM gmail_detections WHERE user_id = ? AND expires_at > ? ORDER BY message_date DESC')
      .bind(userId, new Date().toISOString()).all<DetectionRow>();
    return rows.results.map((row) => ({ detectionId: row.detection_id, receivedAt: row.message_date, sender: row.sender, subject: row.subject, candidates: JSON.parse(row.candidates) as GmailDetectionCandidate[], reasons: JSON.parse(row.reasons) as string[] }));
  }

  detection(userId: string, detectionId: string) {
    return this.db.prepare('SELECT * FROM gmail_detections WHERE user_id = ? AND detection_id = ? AND expires_at > ?').bind(userId, detectionId, new Date().toISOString()).first<DetectionRow>().then((row) => row ?? undefined);
  }

  async removeDetection(userId: string, detectionId: string): Promise<boolean> {
    return (await this.db.prepare('DELETE FROM gmail_detections WHERE user_id = ? AND detection_id = ?').bind(userId, detectionId).run()).meta.changes === 1;
  }

  async disconnectLocal(userId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM gmail_detections WHERE user_id = ?').bind(userId),
      this.db.prepare('DELETE FROM gmail_processed_messages WHERE user_id = ?').bind(userId),
      this.db.prepare('DELETE FROM gmail_detection_resolutions WHERE user_id = ?').bind(userId),
      this.db.prepare('DELETE FROM gmail_oauth_states WHERE user_id = ?').bind(userId),
      this.db.prepare('DELETE FROM gmail_connections WHERE user_id = ?').bind(userId),
      this.db.prepare(`UPDATE user_items SET value = json_remove(value, '$.detection') WHERE user_id = ? AND kind = 'application' AND json_extract(value, '$.detection.source') = 'gmail'`).bind(userId),
    ]);
  }

  async cleanup(now: Date): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM gmail_oauth_states WHERE expires_at <= ?').bind(now.toISOString()),
      this.db.prepare('DELETE FROM gmail_detections WHERE expires_at <= ?').bind(now.toISOString()),
      this.db.prepare('DELETE FROM gmail_processed_messages WHERE expires_at <= ?').bind(now.toISOString()),
      this.db.prepare('DELETE FROM gmail_detection_resolutions WHERE expires_at <= ?').bind(now.toISOString()),
    ]);
  }

  async recordResolution(userId: string, detectionId: string, action: 'accept' | 'dismiss', jobId: string | undefined, now: Date): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO gmail_detection_resolutions (user_id, detection_id, action, job_id, resolved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, detectionId, action, jobId ?? null, now.toISOString(), new Date(now.getTime() + pendingLifetimeMs).toISOString()).run();
  }

  resolution(userId: string, detectionId: string) {
    return this.db.prepare('SELECT action, job_id FROM gmail_detection_resolutions WHERE user_id = ? AND detection_id = ? AND expires_at > ?')
      .bind(userId, detectionId, new Date().toISOString()).first<{ action: 'accept' | 'dismiss'; job_id: string | null }>().then((row) => row ?? undefined);
  }
}

async function googleJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({})) as T & { error?: { message?: string; status?: string } | string };
  if (!response.ok) {
    const error = new Error(`Google API request failed (${response.status})`) as Error & { status?: number; googleStatus?: string };
    error.status = response.status;
    error.googleStatus = typeof value.error === 'object' ? value.error?.status : value.error;
    throw error;
  }
  return value;
}

async function exchangeAuthorizationCode(code: string, verifier: string, env: GmailEnvironment): Promise<GoogleTokenResponse> {
  const config = requireGmailConfig(env);
  const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
  return googleJson<GoogleTokenResponse>('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
}

async function accessToken(connection: ConnectionRow, env: GmailEnvironment, store: GmailStore, now: Date): Promise<string> {
  const config = requireGmailConfig(env);
  const refreshToken = await decryptGmailToken(connection.refresh_token, config.encryptionSecret);
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const token = await googleJson<GoogleTokenResponse>('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!token.access_token) throw new Error('Google did not return an access token');
  if (token.refresh_token) await store.updateRefreshToken(connection.user_id, await encryptGmailToken(token.refresh_token, config.encryptionSecret), now);
  return token.access_token;
}

async function gmailGet<T>(path: string, token: string): Promise<T> {
  return googleJson<T>(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

function metadataFrom(message: GmailMessage): GmailMetadata | undefined {
  if (!message.id || !message.internalDate) return undefined;
  const receivedAt = new Date(Number(message.internalDate)).toISOString();
  if (!Number.isFinite(Date.parse(receivedAt))) return undefined;
  const headers = new Map((message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
  return { sender: headers.get('from') ?? '', subject: headers.get('subject') ?? '', receivedAt, labels: message.labelIds ?? [] };
}

async function applyDetection(userId: string, jobId: string, detectedAt: string, env: GmailEnvironment): Promise<ApplicationRecord> {
  const users = new D1UserStore(env.DB);
  const job = await new D1InternshipStore(env.DB).getJob(jobId);
  if (!job) throw new Error('Catalog role no longer exists');
  const existing = (await users.listApplications(userId)).find((application) => application.jobId === jobId);
  if (existing && terminalApplicationStatuses.has(existing.status)) return existing;
  const application: ApplicationRecord = {
    applicationId: existing?.applicationId ?? crypto.randomUUID(), jobId,
    status: existing?.status === 'saved' || !existing ? 'applied' : existing.status,
    appliedAt: existing?.appliedAt ?? detectedAt,
    detection: { source: 'gmail', detectedAt },
    applyMode: existing?.applyMode ?? 'official-form',
    createdAt: existing?.createdAt ?? detectedAt, updatedAt: new Date().toISOString(),
    ...(existing?.notes ? { notes: existing.notes } : {}),
  };
  await users.putApplication(userId, application);
  return application;
}

async function processMessage(userId: string, messageId: string, token: string, env: GmailEnvironment, catalog: Internship[], now: Date): Promise<{ olderThanBoundary: boolean }> {
  const config = requireGmailConfig(env); const store = new GmailStore(env.DB);
  const messageKey = await hmac(`${userId}:${messageId}`, config.messageSecret);
  if (await store.processed(userId, messageKey)) return { olderThanBoundary: false };
  const message = await gmailGet<GmailMessage>(`/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token);
  const metadata = metadataFrom(message);
  if (!metadata) { await store.markProcessed(userId, messageKey, now); return { olderThanBoundary: false }; }
  const olderThanBoundary = Date.parse(metadata.receivedAt) < now.getTime() - initialLookbackMs;
  if (!olderThanBoundary && metadata.labels.includes('INBOX')) {
    const result = matchGmailApplication(metadata, catalog);
    if (result.outcome === 'applied') await applyDetection(userId, result.candidate.jobId, metadata.receivedAt, env);
    if (result.outcome === 'review') await store.addDetection(userId, messageKey, metadata, result.candidates, result.reasons, now);
  }
  await store.markProcessed(userId, messageKey, now);
  return { olderThanBoundary };
}

export async function processGmailWork(message: GmailWorkMessage, env: GmailEnvironment, now = new Date()): Promise<void> {
  if (message.version !== 1 || !message.userId || !['initial', 'history'].includes(message.mode)) throw new Error('Invalid Gmail work message');
  const store = new GmailStore(env.DB);
  if (!await store.claimLease(message.userId, now)) return;
  const connection = await store.connection(message.userId);
  if (!connection) return;
  const token = await accessToken(connection, env, store, now);
  if (message.mode === 'initial' || !connection.history_id) {
    const parameters = new URLSearchParams({ labelIds: 'INBOX', maxResults: '100' });
    if (message.pageToken) parameters.set('pageToken', message.pageToken);
    const page = await gmailGet<GmailMessageList>(`/messages?${parameters}`, token);
    const catalog = await new D1InternshipStore(env.DB).listCatalog();
    let reachedBoundary = false;
    for (const item of page.messages ?? []) reachedBoundary = (await processMessage(message.userId, item.id, token, env, catalog, now)).olderThanBoundary || reachedBoundary;
    if (page.nextPageToken && !reachedBoundary) {
      await env.GMAIL_QUEUE.send({ ...message, pageToken: page.nextPageToken });
      await store.continued(message.userId, now);
      return;
    }
    const profile = await gmailGet<GmailProfile>('/profile', token);
    await store.synced(message.userId, profile.historyId, now);
    return;
  }
  const parameters = new URLSearchParams({ startHistoryId: connection.history_id, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' });
  if (message.pageToken) parameters.set('pageToken', message.pageToken);
  let page: GmailHistoryList;
  try { page = await gmailGet<GmailHistoryList>(`/history?${parameters}`, token); }
  catch (error) {
    if ((error as { status?: number }).status === 404) {
      await env.DB.prepare("UPDATE gmail_connections SET history_id = NULL, sync_state = 'syncing', lease_until = NULL WHERE user_id = ?").bind(message.userId).run();
      await env.GMAIL_QUEUE.send({ version: 1, userId: message.userId, mode: 'initial', requestedAt: now.toISOString() } satisfies GmailWorkMessage);
      return;
    }
    throw error;
  }
  const messageIds = [...new Set((page.history ?? []).flatMap((history) => history.messagesAdded ?? []).map((item) => item.message.id))];
  const catalog = await new D1InternshipStore(env.DB).listCatalog();
  for (const messageId of messageIds) await processMessage(message.userId, messageId, token, env, catalog, now);
  if (page.nextPageToken) {
    await env.GMAIL_QUEUE.send({ ...message, pageToken: page.nextPageToken });
    await store.continued(message.userId, now);
    return;
  }
  await store.synced(message.userId, page.historyId ?? connection.history_id, now);
}

function appRedirect(status: 'connected' | 'cancelled' | 'error', message?: string): Response {
  const url = new URL('internnotifs://gmail'); url.searchParams.set('status', status); if (message) url.searchParams.set('message', message);
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

export async function gmailCallback(request: Request, env: GmailEnvironment): Promise<Response> {
  const url = new URL(request.url); const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
  if (url.searchParams.has('error')) return appRedirect('cancelled');
  if (!state || !code) return appRedirect('error', 'The Gmail connection response was incomplete.');
  const store = new GmailStore(env.DB); const consumed = await store.consumeOAuthState(state, new Date());
  if (!consumed) return appRedirect('error', 'This Gmail connection link expired or was already used.');
  let grantedRefreshToken: string | undefined;
  try {
    const config = requireGmailConfig(env); const token = await exchangeAuthorizationCode(code, consumed.code_verifier, env);
    if (!token.access_token || !token.refresh_token) throw new Error('Google did not grant offline access');
    grantedRefreshToken = token.refresh_token;
    const profile = await gmailGet<GmailProfile>('/profile', token.access_token);
    await store.connect(consumed.user_id, profile.emailAddress, await encryptGmailToken(token.refresh_token, config.encryptionSecret), new Date());
    await env.GMAIL_QUEUE.send({ version: 1, userId: consumed.user_id, mode: 'initial', requestedAt: new Date().toISOString() } satisfies GmailWorkMessage);
    return appRedirect('connected');
  } catch {
    if (grantedRefreshToken) {
      try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(grantedRefreshToken)}`, { method: 'POST' }); }
      catch { /* A failed connection never stores the credential; remote cleanup is best effort. */ }
    }
    return appRedirect('error', 'Gmail could not be connected. Please try again.');
  }
}

export async function disconnectGmail(userId: string, env: GmailEnvironment): Promise<void> {
  const store = new GmailStore(env.DB); const connection = await store.connection(userId);
  if (connection) {
    try {
      const config = requireGmailConfig(env); const refreshToken = await decryptGmailToken(connection.refresh_token, config.encryptionSecret);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch { /* Local deletion is mandatory even when Google revocation is unavailable. */ }
  }
  await store.disconnectLocal(userId);
}

export async function gmailApi(request: Request, env: GmailEnvironment, userId: string): Promise<Response | undefined> {
  const url = new URL(request.url); const store = new GmailStore(env.DB);
  if (url.pathname === '/me/gmail' && request.method === 'GET') return Response.json(await store.status(userId), { headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/me/gmail/authorization' && request.method === 'POST') {
    if (await store.connection(userId)) return Response.json({ message: 'Disconnect the current Gmail account before connecting another one' }, { status: 409 });
    let config: ReturnType<typeof requireGmailConfig>;
    try { config = requireGmailConfig(env); } catch (error) { return Response.json({ message: (error as Error).message }, { status: 503 }); }
    const state = randomToken(); const verifier = randomToken(64); const challenge = base64Url(new Uint8Array(await digest(verifier)));
    await store.putOAuthState(state, userId, verifier, new Date());
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: gmailScope, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256' })) authorization.searchParams.set(key, value);
    return Response.json({ authorizationUrl: authorization.toString(), returnUrl: 'internnotifs://gmail' }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/me/gmail' && request.method === 'DELETE') { await disconnectGmail(userId, env); return new Response(null, { status: 204 }); }
  if (url.pathname === '/me/gmail/sync' && request.method === 'POST') {
    try { requireGmailConfig(env); } catch (error) { return Response.json({ message: (error as Error).message }, { status: 503 }); }
    const connection = await store.connection(userId); if (!connection) return Response.json({ message: 'Connect Gmail first' }, { status: 409 });
    await env.GMAIL_QUEUE.send({ version: 1, userId, mode: connection.history_id ? 'history' : 'initial', requestedAt: new Date().toISOString() } satisfies GmailWorkMessage);
    return Response.json({ queued: true }, { status: 202 });
  }
  if (url.pathname === '/me/gmail/detections' && request.method === 'GET') return Response.json({ detections: await store.detections(userId) }, { headers: { 'Cache-Control': 'no-store' } });
  const match = url.pathname.match(/^\/me\/gmail\/detections\/([^/]+)\/(accept|dismiss)$/u);
  if (match && request.method === 'POST') {
    const detectionId = decodeURIComponent(match[1]!); const detection = await store.detection(userId, detectionId);
    if (match[2] === 'dismiss') {
      if (detection) { await store.recordResolution(userId, detectionId, 'dismiss', undefined, new Date()); await store.removeDetection(userId, detectionId); }
      return new Response(null, { status: 204 });
    }
    const body = await request.json().catch(() => ({})) as { jobId?: unknown };
    if (!detection) {
      const resolution = await store.resolution(userId, detectionId);
      if (resolution?.action === 'accept' && resolution.job_id === body.jobId) {
        const application = (await new D1UserStore(env.DB).listApplications(userId)).find((item) => item.jobId === resolution.job_id);
        if (application) return Response.json({ application });
      }
      return Response.json({ message: 'Detection not found' }, { status: 404 });
    }
    const candidates = JSON.parse(detection.candidates) as GmailDetectionCandidate[];
    if (typeof body.jobId !== 'string' || !candidates.some((candidate) => candidate.jobId === body.jobId)) return Response.json({ message: 'Choose one of this detection’s catalog roles' }, { status: 400 });
    const application = await applyDetection(userId, body.jobId, detection.message_date, env);
    await store.recordResolution(userId, detectionId, 'accept', body.jobId, new Date()); await store.removeDetection(userId, detectionId);
    return Response.json({ application });
  }
  return undefined;
}

export function gmailRetryCode(error: unknown): string {
  const status = (error as { status?: number }).status;
  if (status === 401 || status === 400) return 'revoked';
  if (status === 429) return 'rate_limited';
  return 'temporary';
}
