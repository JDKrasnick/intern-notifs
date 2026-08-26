import { publicConfig } from './public-config';
import { currentPrivacyVersion, currentTermsVersion } from './policies';
import { sessionStorage, type StoredAuthSession } from './session-storage';

const baseUrl = publicConfig.apiUrl.replace(/\/$/u, '');
const refreshMarginMs = 5 * 60 * 1_000;
let authGeneration = 0;
let validationInFlight: Promise<SessionRestoreResult> | undefined;

export type SessionRestoreResult =
  | { status: 'authenticated'; token: string }
  | { status: 'signed_out'; reason: 'missing' | 'rejected' | 'incomplete' }
  | { status: 'temporarily_unavailable'; message: string };

function normalizedEmail(email: string) { return email.trim().toLowerCase(); }

async function authRequest<T>(path: string, body: Record<string, string | boolean>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? 'Authentication request failed');
  return data;
}

function usable(session: StoredAuthSession, now = Date.now()) {
  return Date.parse(session.expiresAt) > now + refreshMarginMs;
}

async function validate(session: StoredAuthSession, expectedGeneration: number): Promise<SessionRestoreResult> {
  try {
    const response = await fetch(`${baseUrl}/me/preferences`, { headers: { Authorization: `Bearer ${session.token}` } });
    if (authGeneration !== expectedGeneration) return { status: 'signed_out', reason: 'missing' };
    if (response.ok) return { status: 'authenticated', token: session.token };
    if (response.status === 401) {
      authGeneration += 1;
      await sessionStorage.clear();
      return { status: 'signed_out', reason: 'rejected' };
    }
    return { status: 'temporarily_unavailable', message: 'Check your connection and try again.' };
  } catch {
    return { status: 'temporarily_unavailable', message: 'Check your connection and try again.' };
  }
}

async function restoreSessionOnce(forceRefresh: boolean): Promise<SessionRestoreResult> {
  const expectedGeneration = authGeneration;
  const session = await sessionStorage.getSession();
  if (authGeneration !== expectedGeneration) return { status: 'signed_out', reason: 'missing' };
  if (!session) {
    const legacy = await sessionStorage.get();
    if (legacy) {
      await sessionStorage.clearLegacy();
      return { status: 'signed_out', reason: 'incomplete' };
    }
    return { status: 'signed_out', reason: 'missing' };
  }
  if (!usable(session)) {
    authGeneration += 1;
    await sessionStorage.clear();
    return { status: 'signed_out', reason: 'rejected' };
  }
  if (!forceRefresh) return { status: 'authenticated', token: session.token };
  validationInFlight ??= validate(session, expectedGeneration).finally(() => { validationInFlight = undefined; });
  return validationInFlight;
}

export function restoreSession(options: { forceRefresh?: boolean } = {}): Promise<SessionRestoreResult> {
  return restoreSessionOnce(Boolean(options.forceRefresh)).catch(() => ({
    status: 'temporarily_unavailable',
    message: 'Check your connection and try again.',
  }));
}

export async function clearSession(expectedToken?: string) {
  const expectedGeneration = authGeneration;
  if (expectedToken) {
    const stored = await sessionStorage.getSession();
    if (authGeneration !== expectedGeneration || stored?.token !== expectedToken) return false;
  }
  authGeneration += 1;
  validationInFlight = undefined;
  await sessionStorage.clear();
  return true;
}

/** Revokes the current server session when reachable, then always signs out locally. */
export async function signOut(expectedToken?: string): Promise<void> {
  const stored = await sessionStorage.getSession();
  const token = expectedToken ?? stored?.token;
  try {
    if (token) {
      await fetch(`${baseUrl}/auth/signout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch {
    // Local sign-out must still complete while offline. The server session will
    // expire normally if revocation cannot be delivered.
  } finally {
    await clearSession(token);
  }
}

export async function signIn(email: string, password: string): Promise<string> {
  const username = normalizedEmail(email);
  const expectedGeneration = ++authGeneration;
  validationInFlight = undefined;
  const response = await authRequest<{ token: string; expiresAt: string }>('/auth/signin', { email: username, password });
  if (authGeneration !== expectedGeneration) throw new Error('A newer authentication action replaced this sign-in');
  await sessionStorage.setSession({ token: response.token, expiresAt: response.expiresAt, username });
  return response.token;
}

export async function signUp(email: string, password: string, consent: {
  ageAttested: boolean;
  policiesAccepted: boolean;
}): Promise<{
  delivery: 'development' | 'email';
  confirmationCode?: string;
}> {
  if (!consent.ageAttested) throw new Error('Confirm that you are at least 18 years old');
  if (!consent.policiesAccepted) throw new Error('Agree to the Terms and acknowledge the Privacy Policy');
  return authRequest('/auth/signup', {
    email: normalizedEmail(email),
    password,
    ageAttested: true,
    termsVersion: currentTermsVersion,
    privacyVersion: currentPrivacyVersion,
  });
}

export async function confirmEmail(email: string, code: string): Promise<void> {
  await authRequest('/auth/confirm', { email: normalizedEmail(email), code: code.trim() });
}
