import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({ restoreSession: vi.fn(), clear: vi.fn() }));
vi.mock('../src/auth', () => ({ restoreSession: authMocks.restoreSession }));
vi.mock('../src/session-storage', () => ({ sessionStorage: { clear: authMocks.clear } }));

import { ApiError, api, authenticatedRead } from '../src/api';

beforeEach(() => {
  authMocks.restoreSession.mockReset();
  authMocks.clear.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mobile API retries', () => {
  it('retries a transient service-capacity response for a safe read', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Service Unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ alertsEnabled: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    const request = api<{ alertsEnabled: boolean }>('/me/preferences', 'token');
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ alertsEnabled: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry a write that may not be safe to repeat', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Service Unavailable' }), { status: 503 }),
    );
    vi.stubGlobal('fetch', fetcher);

    await expect(api('/me/applications', 'token', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ kind: 'capacity', status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded number of read attempts', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Service Unavailable' }), { status: 503 }),
    );
    vi.stubGlobal('fetch', fetcher);

    const request = api('/me/releases/test', 'token');
    const rejection = expect(request).rejects.toMatchObject({ kind: 'capacity', status: 503 });
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('retries a transport failure for a safe read within the bound', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
    vi.stubGlobal('fetch', fetcher);

    const request = api('/me/preferences', 'token');
    const rejection = expect(request).rejects.toMatchObject({ kind: 'offline' });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not retry a write after a transport failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/me/preferences', 'token', { method: 'PATCH' }))
      .rejects.toMatchObject({ kind: 'offline' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes and retries an authenticated read once after a 401', async () => {
    authMocks.restoreSession
      .mockResolvedValueOnce({ status: 'authenticated', token: 'old-token' })
      .mockResolvedValueOnce({ status: 'authenticated', token: 'new-token' });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ alertsEnabled: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(authenticatedRead('/me/preferences')).resolves.toEqual({ alertsEnabled: true });
    expect(authMocks.restoreSession).toHaveBeenNthCalledWith(1);
    expect(authMocks.restoreSession).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer new-token' }) });
  });

  it('stops after a second 401', async () => {
    authMocks.restoreSession
      .mockResolvedValueOnce({ status: 'authenticated', token: 'old-token' })
      .mockResolvedValueOnce({ status: 'authenticated', token: 'new-token' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(authenticatedRead('/me/preferences')).rejects.toMatchObject({
      kind: 'unauthorized', status: 401,
    });
    expect(authMocks.restoreSession).toHaveBeenCalledTimes(2);
    expect(authMocks.clear).toHaveBeenCalledOnce();
  });

  it('preserves a transient refresh failure as a classified retryable error', async () => {
    authMocks.restoreSession.mockResolvedValue({
      status: 'temporarily_unavailable', message: 'Check your connection and try again.',
    });
    await expect(authenticatedRead('/me/preferences')).rejects.toEqual(
      new ApiError('Check your connection and try again.', 'offline'),
    );
  });
});
