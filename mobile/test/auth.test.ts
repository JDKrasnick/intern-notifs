import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stored: undefined as { token: string; expiresAt: string; username: string } | undefined,
  legacy: undefined as string | undefined,
  storageError: undefined as Error | undefined,
  setSession: vi.fn(),
  clear: vi.fn(),
  clearLegacy: vi.fn(),
}));

vi.mock('../src/session-storage', () => ({
  sessionStorage: {
    get: vi.fn(async () => mocks.legacy),
    getSession: vi.fn(async () => {
      if (mocks.storageError) throw mocks.storageError;
      return mocks.stored;
    }),
    setSession: mocks.setSession,
    clear: mocks.clear,
    clearLegacy: mocks.clearLegacy,
  },
}));

import { clearSession, restoreSession, signIn, signOut, signUp } from '../src/auth';

const future = () => new Date(Date.now() + 60 * 60 * 1_000).toISOString();

beforeEach(() => {
  mocks.stored = undefined;
  mocks.legacy = undefined;
  mocks.storageError = undefined;
  mocks.setSession.mockReset();
  mocks.clear.mockReset();
  mocks.clearLegacy.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

describe('Cloudflare session restoration', () => {
  it('keeps a stored opaque session that is not near expiry', async () => {
    mocks.stored = { token: 'current-token', expiresAt: future(), username: 'student@example.test' };
    await expect(restoreSession()).resolves.toEqual({ status: 'authenticated', token: 'current-token' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears an expired opaque session', async () => {
    mocks.stored = { token: 'expired-token', expiresAt: new Date(0).toISOString(), username: 'student@example.test' };
    await expect(restoreSession()).resolves.toEqual({ status: 'signed_out', reason: 'rejected' });
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('validates a forced refresh without replacing the opaque token', async () => {
    mocks.stored = { token: 'current-token', expiresAt: future(), username: 'student@example.test' };
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(restoreSession({ forceRefresh: true })).resolves.toEqual({ status: 'authenticated', token: 'current-token' });
  });

  it('clears a session rejected during forced validation', async () => {
    mocks.stored = { token: 'rejected-token', expiresAt: future(), username: 'student@example.test' };
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(restoreSession({ forceRefresh: true })).resolves.toEqual({ status: 'signed_out', reason: 'rejected' });
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('preserves the session when validation is temporarily unavailable', async () => {
    mocks.stored = { token: 'current-token', expiresAt: future(), username: 'student@example.test' };
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    await expect(restoreSession({ forceRefresh: true })).resolves.toEqual({
      status: 'temporarily_unavailable', message: 'Check your connection and try again.',
    });
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('rejects a legacy token that has no verifiable expiry', async () => {
    mocks.legacy = 'legacy-token';
    await expect(restoreSession()).resolves.toEqual({ status: 'signed_out', reason: 'incomplete' });
    expect(mocks.clearLegacy).toHaveBeenCalledOnce();
  });

  it('persists the token and expiry returned by Cloudflare sign-in', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ token: 'new-token', expiresAt: future() }), { status: 200 }));
    await expect(signIn(' Student@Example.Test ', 'password')).resolves.toBe('new-token');
    expect(mocks.setSession).toHaveBeenCalledWith({
      token: 'new-token', expiresAt: expect.any(String), username: 'student@example.test',
    });
  });

  it('returns a development confirmation code when Cloudflare supplies one', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ delivery: 'development', confirmationCode: '123456' }), { status: 201 }));
    await expect(signUp(' Student@Example.Test ', 'Password12345')).resolves.toEqual({ delivery: 'development', confirmationCode: '123456' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/auth/signup'), expect.objectContaining({
      body: JSON.stringify({ email: 'student@example.test', password: 'Password12345' }),
    }));
  });

  it('does not clear a newer account for an older request token', async () => {
    mocks.stored = { token: 'user-b-token', expiresAt: future(), username: 'student-b@example.test' };
    await expect(clearSession('user-a-token')).resolves.toBe(false);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('revokes the server session before clearing it locally', async () => {
    mocks.stored = { token: 'current-token', expiresAt: future(), username: 'student@example.test' };
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(signOut()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/auth/signout'), {
      method: 'POST',
      headers: { Authorization: 'Bearer current-token' },
    });
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('still clears the local session when revocation is offline', async () => {
    mocks.stored = { token: 'current-token', expiresAt: future(), username: 'student@example.test' };
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));

    await expect(signOut()).resolves.toBeUndefined();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });
});
