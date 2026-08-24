import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stored: undefined as { idToken: string; refreshToken: string; username: string } | undefined,
  cognitoCached: undefined as { idToken: string; refreshToken: string; username: string } | undefined,
  legacy: undefined as string | undefined,
  refreshError: undefined as Error | undefined,
  refreshedIdToken: 'fresh-token',
  expiration: 0,
  setRefreshable: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../src/api', () => ({
  sessionStorage: {
    get: vi.fn(async () => mocks.legacy),
    getRefreshable: vi.fn(async () => mocks.stored),
    getCognitoCached: vi.fn(async () => mocks.cognitoCached),
    setRefreshable: mocks.setRefreshable,
    clear: mocks.clear,
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
      if (mocks.refreshError) callback(mocks.refreshError);
      else callback(null, {
        getIdToken: () => new CognitoIdToken({}),
        getRefreshToken: () => new CognitoRefreshToken({}),
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

import { restoreSession } from '../src/auth';

beforeEach(() => {
  mocks.stored = undefined;
  mocks.cognitoCached = undefined;
  mocks.legacy = undefined;
  mocks.refreshError = undefined;
  mocks.refreshedIdToken = 'fresh-token';
  mocks.expiration = Math.floor(Date.now() / 1_000) + 3_600;
  mocks.setRefreshable.mockReset();
  mocks.clear.mockReset();
});

describe('Cognito session restoration', () => {
  it('keeps a stored ID token that is not near expiry', async () => {
    mocks.stored = { idToken: 'current-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    await expect(restoreSession()).resolves.toBe('current-token');
    expect(mocks.setRefreshable).not.toHaveBeenCalled();
  });

  it('refreshes an expired ID token and persists the replacement', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    await expect(restoreSession()).resolves.toBe('fresh-token');
    expect(mocks.setRefreshable).toHaveBeenCalledWith({
      idToken: 'fresh-token', refreshToken: 'refresh-token', username: 'student@example.test',
    });
  });

  it('migrates and refreshes the Cognito cache created by earlier builds', async () => {
    mocks.cognitoCached = { idToken: 'expired-token', refreshToken: 'cached-refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    await expect(restoreSession()).resolves.toBe('fresh-token');
    expect(mocks.setRefreshable).toHaveBeenCalledWith({
      idToken: 'fresh-token', refreshToken: 'refresh-token', username: 'student@example.test',
    });
  });

  it('migrates a still-valid Cognito cache without refreshing it', async () => {
    mocks.cognitoCached = { idToken: 'current-token', refreshToken: 'cached-refresh-token', username: 'student@example.test' };
    await expect(restoreSession()).resolves.toBe('current-token');
    expect(mocks.setRefreshable).toHaveBeenCalledWith(mocks.cognitoCached);
  });

  it('clears a refresh token Cognito has revoked', async () => {
    mocks.stored = { idToken: 'expired-token', refreshToken: 'refresh-token', username: 'student@example.test' };
    mocks.expiration = 0;
    mocks.refreshError = Object.assign(new Error('Refresh Token has expired'), { code: 'NotAuthorizedException' });
    await expect(restoreSession()).resolves.toBeUndefined();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('does not keep a legacy expired token that cannot be refreshed', async () => {
    mocks.legacy = 'expired-legacy-token';
    mocks.expiration = 0;
    await expect(restoreSession()).resolves.toBeUndefined();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });
});
