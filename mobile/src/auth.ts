import { AuthenticationDetails, CognitoIdToken, CognitoRefreshToken, CognitoUser, CognitoUserPool, type CognitoUserSession } from 'amazon-cognito-identity-js';
import { publicConfig } from './public-config';
import { sessionStorage } from './session-storage';

const { cognitoUserPoolId: userPoolId, cognitoClientId: clientId } = publicConfig;
function pool() { if (!userPoolId || !clientId) throw new Error('Cognito is not configured'); return new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId }); }
const refreshMarginSeconds = 5 * 60;
let refreshInFlight: Promise<SessionRestoreResult> | undefined;

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

async function saveSession(username: string, session: CognitoUserSession, fallbackRefreshToken?: string) {
  const idToken = session.getIdToken().getJwtToken();
  const refreshToken = session.getRefreshToken().getToken() || fallbackRefreshToken;
  if (!refreshToken) throw new Error('Cognito did not return a refresh token');
  await sessionStorage.setRefreshable({ idToken, refreshToken, username });
  return idToken;
}

function refresh(username: string, refreshToken: string) {
  return new Promise<string>((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: pool() });
    user.refreshSession(new CognitoRefreshToken({ RefreshToken: refreshToken }), (error, session) => {
      if (error) { reject(error); return; }
      void saveSession(username, session as CognitoUserSession, refreshToken).then(resolve, reject);
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
  let stored = await sessionStorage.getRefreshable();
  const requiresMigration = !stored;
  stored ??= await sessionStorage.getCognitoCached();
  if (stored) {
    if (!forceRefresh && !idTokenNeedsRefresh(stored.idToken)) {
      if (requiresMigration) await sessionStorage.setRefreshable(stored);
      return { status: 'authenticated', token: stored.idToken };
    }
    if (!refreshInFlight) {
      const operation = (async (): Promise<SessionRestoreResult> => {
        try {
          return { status: 'authenticated', token: await refresh(stored.username, stored.refreshToken) };
        } catch (error) {
          if (refreshTokenRejected(error)) {
            await sessionStorage.clear();
            return { status: 'signed_out', reason: 'rejected' };
          }
          return { status: 'temporarily_unavailable', message: temporaryRefreshMessage(error) };
        }
      })();
      refreshInFlight = operation;
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

export function signIn(email: string, password: string): Promise<string> {
  const username = normalizedEmail(email);
  return new Promise((resolve, reject) => new CognitoUser({ Username: username, Pool: pool() }).authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), { onSuccess: (session) => { void saveSession(username, session).then(resolve, reject); }, onFailure: reject, newPasswordRequired: () => reject(new Error('Set a new password in the Cognito console before signing in.')) }));
}
export function signUp(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => pool().signUp(normalizedEmail(email), password, [], [], (error) => error ? reject(error) : resolve()));
}
export function confirmEmail(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => new CognitoUser({ Username: normalizedEmail(email), Pool: pool() }).confirmRegistration(code.trim(), true, (error) => error ? reject(error) : resolve()));
}
