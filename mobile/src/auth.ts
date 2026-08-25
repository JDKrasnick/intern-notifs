import { AuthenticationDetails, CognitoIdToken, CognitoRefreshToken, CognitoUser, CognitoUserPool, type CognitoUserSession } from 'amazon-cognito-identity-js';
import { publicConfig } from './public-config';
import { sessionStorage } from './session-storage';

const { cognitoUserPoolId: userPoolId, cognitoClientId: clientId } = publicConfig;
function pool() { if (!userPoolId || !clientId) throw new Error('Cognito is not configured'); return new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId }); }
const refreshMarginSeconds = 5 * 60;
let refreshInFlight: Promise<SessionRestoreResult> | undefined;
let refreshGeneration = -1;
let authGeneration = 0;

class StaleAuthenticationOperation extends Error {}

export type SessionRestoreResult =
  | { status: 'authenticated'; token: string }
  | { status: 'signed_out'; reason: 'missing' | 'rejected' | 'incomplete' }
  | { status: 'temporarily_unavailable'; message: string };

function normalizedEmail(email: string) { return email.trim().toLowerCase(); }

export function idTokenNeedsRefresh(token: string, now = () => Date.now()) {
  try {
    return new CognitoIdToken({ IdToken: token }).getExpiration() <= Math.floor(now() / 1_000) + refreshMarginSeconds;
  } catch {
    return true;
  }
}

async function saveSession(username: string, session: CognitoUserSession, fallbackRefreshToken?: string, expectedGeneration = authGeneration) {
  const idToken = session.getIdToken().getJwtToken();
  const refreshToken = session.getRefreshToken().getToken() || fallbackRefreshToken;
  if (!refreshToken) throw new Error('Cognito did not return a refresh token');
  if (authGeneration !== expectedGeneration) throw new StaleAuthenticationOperation();
  await sessionStorage.setRefreshable({ idToken, refreshToken, username });
  return idToken;
}

function refresh(username: string, refreshToken: string, expectedGeneration: number) {
  return new Promise<string>((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: pool() });
    user.refreshSession(new CognitoRefreshToken({ RefreshToken: refreshToken }), (error, session) => {
      if (error) { reject(error); return; }
      void saveSession(username, session as CognitoUserSession, refreshToken, expectedGeneration).then(resolve, reject);
    });
  });
}

function refreshTokenRejected(error: unknown) {
  const value = error as { code?: string; name?: string };
  return value?.code === 'NotAuthorizedException' || value?.name === 'NotAuthorizedException';
}

function temporaryRefreshMessage(error: unknown) {
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'The request timed out. Check your connection and try again.';
  return 'Check your connection and try again.';
}

async function restoreSessionOnce(forceRefresh: boolean): Promise<SessionRestoreResult> {
  const expectedGeneration = authGeneration;
  let stored = await sessionStorage.getRefreshable();
  const requiresMigration = !stored;
  stored ??= await sessionStorage.getCognitoCached();
  if (authGeneration !== expectedGeneration) return { status: 'signed_out', reason: 'missing' };
  if (stored) {
    if (!forceRefresh && !idTokenNeedsRefresh(stored.idToken)) {
      if (requiresMigration && authGeneration === expectedGeneration) await sessionStorage.setRefreshable(stored);
      return { status: 'authenticated', token: stored.idToken };
    }
    if (!refreshInFlight || refreshGeneration !== expectedGeneration) {
      const operation = (async (): Promise<SessionRestoreResult> => {
        try {
          return { status: 'authenticated', token: await refresh(stored.username, stored.refreshToken, expectedGeneration) };
        } catch (error) {
          if (error instanceof StaleAuthenticationOperation) return { status: 'signed_out', reason: 'missing' };
          if (refreshTokenRejected(error)) {
            if (authGeneration !== expectedGeneration) return { status: 'signed_out', reason: 'missing' };
            authGeneration += 1;
            await sessionStorage.clear();
            return { status: 'signed_out', reason: 'rejected' };
          }
          return { status: 'temporarily_unavailable', message: temporaryRefreshMessage(error) };
        }
      })();
      refreshInFlight = operation;
      refreshGeneration = expectedGeneration;
      const clearFlight = () => {
        if (refreshInFlight === operation) refreshInFlight = undefined;
      };
      void operation.then(clearFlight, clearFlight);
    }
    return refreshInFlight;
  }
  const legacyToken = await sessionStorage.get();
  if (legacyToken) {
    await sessionStorage.clearLegacy();
    return { status: 'signed_out', reason: 'incomplete' };
  }
  return { status: 'signed_out', reason: 'missing' };
}

/** Restores a usable session. Concurrent refreshes share one Cognito request. */
export function restoreSession(options: { forceRefresh?: boolean } = {}): Promise<SessionRestoreResult> {
  return restoreSessionOnce(Boolean(options.forceRefresh)).catch(() => ({
    status: 'temporarily_unavailable',
    message: 'Check your connection and try again.',
  }));
}

/** Invalidates pending authentication work before deleting persisted credentials. */
export async function clearSession(expectedIdToken?: string) {
  const expectedGeneration = authGeneration;
  if (expectedIdToken) {
    const stored = await sessionStorage.getRefreshable();
    if (authGeneration !== expectedGeneration || stored?.idToken !== expectedIdToken) return false;
  }
  authGeneration += 1;
  refreshInFlight = undefined;
  refreshGeneration = -1;
  await sessionStorage.clear();
  return true;
}

export function signIn(email: string, password: string): Promise<string> {
  const username = normalizedEmail(email);
  const expectedGeneration = ++authGeneration;
  refreshInFlight = undefined;
  refreshGeneration = -1;
  return new Promise((resolve, reject) => new CognitoUser({ Username: username, Pool: pool() }).authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), { onSuccess: (session) => { void saveSession(username, session, undefined, expectedGeneration).then(resolve, reject); }, onFailure: reject, newPasswordRequired: () => reject(new Error('Set a new password in the Cognito console before signing in.')) }));
}
export function signUp(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => pool().signUp(normalizedEmail(email), password, [], [], (error) => error ? reject(error) : resolve()));
}
export function confirmEmail(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => new CognitoUser({ Username: normalizedEmail(email), Pool: pool() }).confirmRegistration(code.trim(), true, (error) => error ? reject(error) : resolve()));
}
