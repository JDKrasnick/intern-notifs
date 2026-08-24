import { AuthenticationDetails, CognitoIdToken, CognitoRefreshToken, CognitoUser, CognitoUserPool, type CognitoUserSession } from 'amazon-cognito-identity-js';
import { publicConfig } from './public-config';
import { sessionStorage } from './api';

const { cognitoUserPoolId: userPoolId, cognitoClientId: clientId } = publicConfig;
function pool() { if (!userPoolId || !clientId) throw new Error('Cognito is not configured'); return new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId }); }
const refreshMarginSeconds = 5 * 60;

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

/** Restores a usable ID token and refreshes it before account reads can fail. */
export async function restoreSession(): Promise<string | undefined> {
  let stored = await sessionStorage.getRefreshable();
  const requiresMigration = !stored;
  stored ??= await sessionStorage.getCognitoCached();
  if (stored) {
    if (!idTokenNeedsRefresh(stored.idToken)) {
      if (requiresMigration) await sessionStorage.setRefreshable(stored);
      return stored.idToken;
    }
    try {
      return await refresh(stored.username, stored.refreshToken);
    } catch (error) {
      if (!refreshTokenRejected(error)) throw error;
      await sessionStorage.clear();
      return undefined;
    }
  }
  const legacyToken = await sessionStorage.get();
  if (legacyToken && !idTokenNeedsRefresh(legacyToken)) return legacyToken;
  if (legacyToken) await sessionStorage.clear();
  return undefined;
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
