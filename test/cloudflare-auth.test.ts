import { describe, expect, it, vi } from 'vitest';
import { signOut } from '../cloudflare/auth.js';
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
