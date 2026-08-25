import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn(async (key: string) => { values.delete(key); }),
      getAllKeys: vi.fn(async () => [...values.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => values.delete(key)); }),
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage.api }));

import { sessionStorage } from '../src/session-storage';

const appSessionKey = 'internnotifs.authSession';
const legacyKey = 'internnotifs.idToken';

beforeEach(() => {
  storage.values.clear();
  vi.clearAllMocks();
});

describe('session storage', () => {
  it('ignores corrupted or incomplete session JSON', async () => {
    storage.values.set(appSessionKey, '{not-json');
    await expect(sessionStorage.getSession()).resolves.toBeUndefined();
    storage.values.set(appSessionKey, JSON.stringify({ token: 'missing-expiry' }));
    await expect(sessionStorage.getSession()).resolves.toBeUndefined();
  });

  it('persists a complete opaque session and legacy token mirror', async () => {
    const session = { token: 'token', expiresAt: '2026-09-01T00:00:00.000Z', username: 'student@example.test' };
    await sessionStorage.setSession(session);
    await expect(sessionStorage.getSession()).resolves.toEqual(session);
    expect(storage.values.get(legacyKey)).toBe('token');
  });

  it('clears app credentials and old Cognito cache without touching unrelated data', async () => {
    storage.values.set(legacyKey, 'token');
    storage.values.set(appSessionKey, '{}');
    storage.values.set('@MemoryStorage:CognitoIdentityServiceProvider.old.LastAuthUser', 'student');
    storage.values.set('unrelated', 'keep');
    await sessionStorage.clear();
    expect(storage.values).toEqual(new Map([['unrelated', 'keep']]));
  });
});
