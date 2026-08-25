import type { D1Database } from './types.js';

const encoder = new TextEncoder();
// Cloudflare Workers caps Web Crypto PBKDF2 at 100,000 iterations.
const passwordIterations = 100_000;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const confirmationLifetimeMs = 30 * 60 * 1_000;

export interface AuthEnvironment {
  DB: D1Database;
  AUTH_SESSION_SECRET: string;
  AUTH_DEV_MODE?: string;
  RESEND_API_KEY?: string;
  AUTH_FROM_EMAIL?: string;
}

type AuthUserRow = {
  user_id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  verified_at: string | null;
  confirmation_hash: string | null;
  confirmation_expires_at: string | null;
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function sessionSecret(env: AuthEnvironment): string {
  if (!env.AUTH_SESSION_SECRET || env.AUTH_SESSION_SECRET.length < 32) throw new Error('Authentication is not configured');
  return env.AUTH_SESSION_SECRET;
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: passwordIterations }, key, 256);
  return base64Url(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Email is required');
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) throw new Error('Enter a valid email address');
  return email;
}

function requirePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || !/[a-z]/u.test(value) || !/[A-Z]/u.test(value) || !/\d/u.test(value)) {
    throw new Error('Password must be at least 12 characters with upper-case, lower-case, and numeric characters');
  }
  return value;
}

async function sendConfirmation(email: string, code: string, env: AuthEnvironment): Promise<void> {
  if (env.AUTH_DEV_MODE === 'true') return;
  if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL) throw new Error('Email verification is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [email],
      subject: 'Verify your InternNotifs email',
      text: `Your InternNotifs verification code is ${code}. It expires in 30 minutes.`,
    }),
  });
  if (!response.ok) throw new Error('Could not send the verification email');
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try { return await request.json() as Record<string, unknown>; } catch { throw new Error('Request body must be valid JSON'); }
}

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function signUp(request: Request, env: AuthEnvironment): Promise<Response> {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  const password = requirePassword(input.password);
  const timestamp = new Date();
  const salt = randomToken(16);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const confirmationHash = await sha256(`${sessionSecret(env)}:${code}`);
  const existing = await env.DB.prepare('SELECT user_id, verified_at FROM auth_users WHERE email = ?').bind(email).first<{ user_id: string; verified_at: string | null }>();
  if (existing?.verified_at) return json(409, { message: 'An account already exists for this email' });
  const userId = existing?.user_id ?? crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO auth_users (user_id, email, password_hash, password_salt, confirmation_hash, confirmation_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt,
      confirmation_hash = excluded.confirmation_hash, confirmation_expires_at = excluded.confirmation_expires_at, updated_at = excluded.updated_at
  `).bind(userId, email, await passwordHash(password, salt), salt, confirmationHash, new Date(timestamp.getTime() + confirmationLifetimeMs).toISOString(), timestamp.toISOString(), timestamp.toISOString()).run();
  await sendConfirmation(email, code, env);
  return json(201, { ...(env.AUTH_DEV_MODE === 'true' ? { confirmationCode: code } : {}) });
}

export async function confirmEmail(request: Request, env: AuthEnvironment): Promise<Response> {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  if (typeof input.code !== 'string') throw new Error('Verification code is required');
  const user = await env.DB.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email).first<AuthUserRow>();
  const submitted = await sha256(`${sessionSecret(env)}:${input.code.trim()}`);
  if (!user?.confirmation_hash || !user.confirmation_expires_at || Date.parse(user.confirmation_expires_at) <= Date.now() || !constantTimeEqual(user.confirmation_hash, submitted)) {
    return json(400, { message: 'Verification code is invalid or expired' });
  }
  const timestamp = new Date().toISOString();
  await env.DB.prepare('UPDATE auth_users SET verified_at = ?, confirmation_hash = NULL, confirmation_expires_at = NULL, updated_at = ? WHERE user_id = ?').bind(timestamp, timestamp, user.user_id).run();
  return new Response(null, { status: 204 });
}

export async function signIn(request: Request, env: AuthEnvironment): Promise<Response> {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  if (typeof input.password !== 'string') throw new Error('Password is required');
  const user = await env.DB.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email).first<AuthUserRow>();
  const candidate = user ? await passwordHash(input.password, user.password_salt) : await passwordHash(input.password, randomToken(16));
  if (!user || !constantTimeEqual(user.password_hash, candidate)) return json(401, { message: 'Email or password is incorrect' });
  if (!user.verified_at) return json(403, { message: 'Verify your email before signing in' });
  const token = randomToken();
  const timestamp = new Date();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(`${sessionSecret(env)}:${token}`), user.user_id, new Date(timestamp.getTime() + sessionLifetimeMs).toISOString(), timestamp.toISOString()).run();
  return json(200, { token, expiresAt: new Date(timestamp.getTime() + sessionLifetimeMs).toISOString() });
}

export async function signOut(request: Request, env: AuthEnvironment): Promise<Response> {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length);
    if (token) {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
        .bind(await sha256(`${sessionSecret(env)}:${token}`)).run();
    }
  }
  // Signing out is idempotent and does not reveal whether a token was valid.
  return new Response(null, { status: 204 });
}

export async function authenticatedUser(request: Request, env: AuthEnvironment): Promise<string | undefined> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const hash = await sha256(`${sessionSecret(env)}:${authorization.slice('Bearer '.length)}`);
  const session = await env.DB.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').bind(hash, new Date().toISOString()).first<{ user_id: string }>();
  return session?.user_id;
}

export async function deleteAuthUser(userId: string, env: AuthEnvironment): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_users WHERE user_id = ?').bind(userId).run();
}

export async function cleanupExpiredAuth(env: AuthEnvironment): Promise<void> {
  const timestamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(timestamp),
    env.DB.prepare('UPDATE auth_users SET confirmation_hash = NULL, confirmation_expires_at = NULL WHERE confirmation_expires_at <= ?').bind(timestamp),
  ]);
}

export async function handleAuthRequest(request: Request, env: AuthEnvironment): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === 'POST' && path === '/auth/signup') return await signUp(request, env);
    if (request.method === 'POST' && path === '/auth/confirm') return await confirmEmail(request, env);
    if (request.method === 'POST' && path === '/auth/signin') return await signIn(request, env);
    if (request.method === 'POST' && path === '/auth/signout') return await signOut(request, env);
    return undefined;
  } catch (error) {
    return json(400, { message: error instanceof Error ? error.message : 'Invalid request' });
  }
}
