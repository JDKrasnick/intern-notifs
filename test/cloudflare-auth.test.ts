import { describe, expect, it, vi } from 'vitest';
import { cleanupExpiredAuth, consumeAuthRateLimit, handleAuthRequest, signOut } from '../cloudflare/auth.js';
import type { AuthEnvironment } from '../cloudflare/auth.js';

function environment(run = vi.fn(async () => ({}))) {
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
    } as unknown as AuthEnvironment,
    prepare,
    bind,
    run,
  };
}

describe('Cloudflare sign-out', () => {
  it('revokes the presented session and remains idempotent', async () => {
    const database = environment();
    const response = await signOut(new Request('https://example.test/auth/signout', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    }), database.env);

    expect(response.status).toBe(204);
    expect(database.prepare).toHaveBeenCalledWith('DELETE FROM auth_sessions WHERE token_hash = ?');
    expect(database.bind).toHaveBeenCalledWith(expect.any(String));
    expect(database.run).toHaveBeenCalledOnce();
  });

  it('returns success without querying for a missing token', async () => {
    const database = environment();
    const response = await signOut(new Request('https://example.test/auth/signout', {
      method: 'POST',
    }), database.env);

    expect(response.status).toBe(204);
    expect(database.prepare).not.toHaveBeenCalled();
  });
});

describe('Cloudflare authentication abuse controls', () => {
  it('blocks a rate-limit key after its configured attempt budget', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const first = vi.fn(async () => ({ attempts: 4, blocked_until: 61_000 }));
    const bind = vi.fn(() => ({ run, first }));
    const prepare = vi.fn(() => ({ bind }));
    const env = {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
    } as unknown as AuthEnvironment;

    await expect(consumeAuthRateLimit(env, 'confirm:account', 'student@example.test', {
      limit: 3, windowMs: 60_000, blockMs: 60_000,
    }, 1_000)).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(bind.mock.calls.flatMap(([...values]) => values)).not.toContain('student@example.test');
  });

  it('returns 429 with retry guidance when an endpoint budget is exhausted', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        run,
        first: vi.fn(async () => query.includes('SELECT attempts')
          ? { attempts: 11, blocked_until: Date.now() + 60_000 }
          : null),
      })),
    }));
    const response = await handleAuthRequest(new Request('https://example.test/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: 'student@example.test', password: 'ValidPassword123' }),
    }), {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
    } as unknown as AuthEnvironment);

    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('rejects oversized request bodies before touching D1', async () => {
    const prepare = vi.fn();
    const response = await handleAuthRequest(new Request('https://example.test/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'student@example.test', password: `Password1${'x'.repeat(17_000)}` }),
    }), {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
    } as unknown as AuthEnvironment);

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ message: 'Request body is too large' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects passwords above the hashing work bound before touching D1', async () => {
    const prepare = vi.fn();
    const response = await handleAuthRequest(new Request('https://example.test/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: 'student@example.test', password: `Password1${'x'.repeat(129)}` }),
    }), {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
    } as unknown as AuthEnvironment);

    expect(response?.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not rotate credentials for an unexpired pending account', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        run,
        first: vi.fn(async () => query.includes('auth_rate_limits')
          ? { attempts: 1, blocked_until: null }
          : { user_id: 'pending-user', verified_at: null, confirmation_expires_at: '2099-01-01T00:00:00.000Z' }),
      })),
    }));
    const response = await handleAuthRequest(new Request('https://example.test/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      body: JSON.stringify({
        email: 'student@example.test', password: 'ValidPassword123', ageAttested: true,
        termsVersion: '2026-08-25', privacyVersion: '2026-08-25',
      }),
    }), {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
      AUTH_DEV_MODE: 'true',
    } as unknown as AuthEnvironment);

    expect(response?.status).toBe(409);
    expect(prepare.mock.calls.some(([query]) => query.includes('ON CONFLICT(email) DO UPDATE'))).toBe(false);
  });

  it('allows signup to retry immediately after verification email delivery fails', async () => {
    let pending: {
      user_id: string;
      verified_at: null;
      confirmation_hash: string | null;
      confirmation_expires_at: string | null;
    } | undefined;
    const prepare = vi.fn((query: string) => ({
      bind: (...values: unknown[]) => ({
        async first() {
          if (query.includes('SELECT attempts')) return { attempts: 1, blocked_until: null };
          if (query.includes('SELECT user_id, verified_at')) return pending ?? null;
          return null;
        },
        async run() {
          if (query.includes('INSERT INTO auth_users')) {
            pending = {
              user_id: values[0] as string,
              verified_at: null,
              confirmation_hash: values[4] as string,
              confirmation_expires_at: values[5] as string,
            };
          }
          const current = pending;
          if (query.includes('UPDATE auth_users SET confirmation_hash = NULL')
            && current
            && current.user_id === values[1]
            && current.confirmation_hash === values[2]) {
            pending = { ...current, confirmation_hash: null, confirmation_expires_at: null };
          }
          return { meta: { changes: 1 } };
        },
      }),
    }));
    const env = {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      RESEND_API_KEY: 'resend-key',
      AUTH_FROM_EMAIL: 'InternNotifs <alerts@example.test>',
      DB: { prepare },
    } as unknown as AuthEnvironment;
    const signup = () => handleAuthRequest(new Request('https://example.test/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: 'student@example.test', password: 'ValidPassword123', ageAttested: true,
        termsVersion: '2026-08-25', privacyVersion: '2026-08-25',
      }),
    }), env);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })));

    await expect(signup()).resolves.toMatchObject({ status: 400 });
    expect(pending?.confirmation_expires_at).toBeNull();
    await expect(signup()).resolves.toMatchObject({ status: 201 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('requires the current policy versions and an adult attestation', async () => {
    const prepare = vi.fn();
    const env = {
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare },
    } as unknown as AuthEnvironment;
    const signup = (body: Record<string, unknown>) => handleAuthRequest(new Request('https://example.test/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'student@example.test', password: 'ValidPassword123', ...body }),
    }), env);

    await expect(signup({ ageAttested: false, termsVersion: '2026-08-25', privacyVersion: '2026-08-25' }))
      .resolves.toMatchObject({ status: 400 });
    await expect(signup({ ageAttested: true, termsVersion: 'old', privacyVersion: '2026-08-25' }))
      .resolves.toMatchObject({ status: 400 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('deletes abandoned unverified accounts after seven days', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const DB = {
      prepare(query: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async run() { statements.push({ query, values }); return { meta: { changes: 0 } }; },
        };
      },
      async batch(prepared: Array<{ run(): Promise<unknown> }>) { await Promise.all(prepared.map((item) => item.run())); return []; },
    };
    await cleanupExpiredAuth({
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB,
    } as unknown as AuthEnvironment, new Date('2026-08-25T12:00:00.000Z'));

    const deletion = statements.find(({ query }) => query.includes('DELETE FROM auth_users'));
    expect(deletion?.values).toEqual(['2026-08-18T12:00:00.000Z']);
  });
});
