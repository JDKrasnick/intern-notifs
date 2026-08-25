import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stored: undefined as { idToken: string; refreshToken: string; username: string } | undefined,
  cognitoCached: undefined as { idToken: string; refreshToken: string; username: string } | undefined,
  legacy: undefined as string | undefined,
  storageError: undefined as Error | undefined,
  refreshError: undefined as Error | undefined,
  refreshedIdToken: 'fresh-token',
  returnedRefreshToken: 'refresh-token',
  expiration: 0,
  refreshCalls: 0,
  deferRefresh: false,
  pendingRefresh: undefined as undefined | ((error: Error | null, session?: unknown) => void),
  setRefreshable: vi.fn(),
  clear: vi.fn(),
  clearLegacy: vi.fn(),
}));

vi.mock('../src/session-storage', () => ({
  sessionStorage: {
    get: vi.fn(async () => mocks.legacy),
    getRefreshable: vi.fn(async () => {
      if (mocks.storageError) throw mocks.storageError;
      return mocks.stored;
    }),
    getCognitoCached: vi.fn(async () => mocks.cognitoCached),
    setRefreshable: mocks.setRefreshable,
    clear: mocks.clear,
    clearLegacy: mocks.clearLegacy,
  },
}));

vi.mock('amazon-cognito-identity-js', () => {
  class CognitoIdToken {
    constructor(_value: unknown) {}
    getExpiration() { return mocks.expiration; }
    getJwtToken() { return mocks.refreshedIdToken; }
  }
  class CognitoRefreshToken {
    constructor(_value: unknown) {}
    getToken() { return 'refresh-token'; }
  }
  class CognitoUser {
    constructor(_value: unknown) {}
    refreshSession(_token: unknown, callback: (error: Error | null, session?: unknown) => void) {
      mocks.refreshCalls += 1;
      if (mocks.deferRefresh) { mocks.pendingRefresh = callback; return; }
      if (mocks.refreshError) callback(mocks.refreshError);
      else callback(null, {
        getIdToken: () => new CognitoIdToken({}),
        getRefreshToken: () => ({ getToken: () => mocks.returnedRefreshToken }),
      });
    }
    authenticateUser(_details: unknown, callbacks: { onSuccess: (session: unknown) => void }) {
      callbacks.onSuccess({
        getIdToken: () => new CognitoIdToken({}),
        getRefreshToken: () => ({ getToken: () => mocks.returnedRefreshToken }),
      });
    }
  }
  return {
    AuthenticationDetails: class { constructor(_value: unknown) {} },
    CognitoIdToken,
    CognitoRefreshToken,
    CognitoUser,
    CognitoUserPool: class { constructor(_value: unknown) {} },
  };
});

import { clearSession, restoreSession, signIn } from '../src/auth';

beforeEach(() => {
  mocks.stored = undefined;
  mocks.cognitoCached = undefined;
  mocks.legacy = undefined;
  mocks.storageError = undefined;
  mocks.refreshError = undefined;
  mocks.refreshedIdToken = 'fresh-token';
  mocks.returnedRefreshToken = 'refresh-token';
  mocks.expiration = Math.floor(Date.now() / 1_000) + 3_600;
  mocks.refreshCalls = 0;
  mocks.deferRefresh = false;
  mocks.pendingRefresh = undefined;
  mocks.setRefreshable.mockReset();
  mocks.clear.mockReset();
  mocks.clearLegacy.mockReset();
});

describe('Cognito session restoration', () => {
  it('keeps a stored ID token that is not near expiry', async () => {
    mocks.stored = { idToken: 'current-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    await expect(restoreSession()).resolves.toEqual({ status: 'authenticated', token: 'current-token' });
    expect(mocks.setRefreshable).not.toHaveBeenCalled();
  });

  it('refreshes an expired ID token and persists the replacement', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    await expect(restoreSession()).resolves.toEqual({ status: 'authenticated', token: 'fresh-token' });
    expect(mocks.setRefreshable).toHaveBeenCalledWith({
      idToken: 'fresh-token', refreshToken: 'refresh-token', username: 'student@example.test',
    });
  });

  it('migrates and refreshes the Cognito cache created by earlier builds', async () => {
    mocks.cognitoCached = { idToken: 'expired-token', refreshToken: 'cached-refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    await expect(restoreSession()).resolves.toEqual({ status: 'authenticated', token: 'fresh-token' });
    expect(mocks.setRefreshable).toHaveBeenCalledWith({
      idToken: 'fresh-token', refreshToken: 'refresh-token', username: 'student@example.test',
    });
  });

  it('migrates a still-valid Cognito cache without refreshing it', async () => {
    mocks.cognitoCached = { idToken: 'current-token', refreshToken: 'cached-refresh-token', username: 'student@example.test' };
    await expect(restoreSession()).resolves.toEqual({ status: 'authenticated', token: 'current-token' });
    expect(mocks.setRefreshable).toHaveBeenCalledWith(mocks.cognitoCached);
  });

  it('clears a refresh token Cognito has revoked', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    mocks.refreshError = Object.assign(new Error('Refresh Token has expired'), { code: 'NotAuthorizedException' });
    await expect(restoreSession()).resolves.toEqual({ status: 'signed_out', reason: 'rejected' });
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('does not keep a legacy expired token that cannot be refreshed', async () => {
    mocks.legacy = 'expired-legacy-token';
    mocks.expiration = 0;
    await expect(restoreSession()).resolves.toEqual({ status: 'signed_out', reason: 'incomplete' });
    expect(mocks.clearLegacy).toHaveBeenCalledOnce();
  });

  it('rejects a valid-looking legacy token without a refresh credential', async () => {
    mocks.legacy = 'unverifiable-legacy-token';
    await expect(restoreSession()).resolves.toEqual({ status: 'signed_out', reason: 'incomplete' });
    expect(mocks.clearLegacy).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('preserves storage and returns a retryable outcome when refresh fails transiently', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    mocks.refreshError = new Error('Network request failed');
    await expect(restoreSession()).resolves.toEqual({
      status: 'temporarily_unavailable', message: 'Check your connection and try again.',
    });
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('returns a retryable outcome when device storage is temporarily unavailable', async () => {
    mocks.storageError = new Error('Storage unavailable');
    await expect(restoreSession()).resolves.toEqual({
      status: 'temporarily_unavailable', message: 'Check your connection and try again.',
    });
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('shares one refresh between concurrent callers', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    const [first, second] = await Promise.all([restoreSession(), restoreSession()]);
    expect(first).toEqual({ status: 'authenticated', token: 'fresh-token' });
    expect(second).toEqual(first);
    expect(mocks.refreshCalls).toBe(1);
  });

  it('persists the fallback refresh token when Cognito omits it', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'fallback-token', username: 'student@example.test' };
    mocks.expiration = 0;
    mocks.returnedRefreshToken = '';
    await restoreSession();
    expect(mocks.setRefreshable).toHaveBeenCalledWith({
      idToken: 'fresh-token', refreshToken: 'fallback-token', username: 'student@example.test',
    });
  });

  it('does not persist a refresh that completes after sign-out', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student-a@example.test' };
    mocks.expiration = 0;
    mocks.deferRefresh = true;
    const restoring = restoreSession();
    await vi.waitFor(() => expect(mocks.pendingRefresh).toBeTypeOf('function'));
    await clearSession();
    mocks.pendingRefresh!(null, {
      getIdToken: () => new (class { getJwtToken() { return 'stale-a-token'; } })(),
      getRefreshToken: () => ({ getToken: () => 'stale-a-refresh' }),
    });
    await expect(restoring).resolves.toEqual({ status: 'signed_out', reason: 'missing' });
    expect(mocks.setRefreshable).not.toHaveBeenCalled();
  });

  it('does not let an old rejected refresh clear a newly signed-in user', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student-a@example.test' };
    mocks.expiration = 0;
    mocks.deferRefresh = true;
    const restoring = restoreSession();
    await vi.waitFor(() => expect(mocks.pendingRefresh).toBeTypeOf('function'));
    await signIn('student-b@example.test', 'password');
    mocks.pendingRefresh!(Object.assign(new Error('revoked'), { code: 'NotAuthorizedException' }));
    await expect(restoring).resolves.toEqual({ status: 'signed_out', reason: 'missing' });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.setRefreshable).toHaveBeenLastCalledWith({
      idToken: 'fresh-token', refreshToken: 'refresh-token', username: 'student-b@example.test',
    });
  });

  it('does not clear the current account for an older request token', async () => {
    mocks.stored = { idToken: 'user-b-token', refreshToken: 'user-b-refresh', username: 'student-b@example.test' };
    await expect(clearSession('user-a-token')).resolves.toBe(false);
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
