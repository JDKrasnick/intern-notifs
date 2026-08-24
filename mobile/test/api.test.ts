import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';

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
      .rejects.toThrow('Service Unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded number of read attempts', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Service Unavailable' }), { status: 503 }),
    );
    vi.stubGlobal('fetch', fetcher);

    const request = api('/me/releases/test', 'token');
    const rejection = expect(request).rejects.toThrow('Service Unavailable');
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
