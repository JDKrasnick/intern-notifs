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

import { publicConfig } from '../src/public-config';
import { sessionStorage } from '../src/session-storage';

const appSessionKey = 'internnotifs.authSession';
const legacyKey = 'internnotifs.idToken';
const cognitoPrefix = `@MemoryStorage:CognitoIdentityServiceProvider.${publicConfig.cognitoClientId}`;

beforeEach(() => {
  storage.values.clear();
  vi.clearAllMocks();
});

describe('session storage', () => {
  it('ignores corrupted refreshable JSON', async () => {
    storage.values.set(appSessionKey, '{not-json');
    await expect(sessionStorage.getRefreshable()).resolves.toBeUndefined();
  });

  it('restores only a complete Cognito cache', async () => {
    storage.values.set(`${cognitoPrefix}.LastAuthUser`, 'student');
    storage.values.set(`${cognitoPrefix}.student.idToken`, 'id-token');
    await expect(sessionStorage.getCognitoCached()).resolves.toBeUndefined();

    storage.values.set(`${cognitoPrefix}.student.refreshToken`, 'refresh-token');
    await expect(sessionStorage.getCognitoCached()).resolves.toEqual({
      idToken: 'id-token', refreshToken: 'refresh-token', username: 'student',
    });
  });

  it('clears app credentials and Cognito cache without touching unrelated data', async () => {
    storage.values.set(legacyKey, 'id-token');
    storage.values.set(appSessionKey, '{}');
    storage.values.set(`${cognitoPrefix}.LastAuthUser`, 'student');
    storage.values.set('unrelated', 'keep');
    await sessionStorage.clear();
    expect(storage.values).toEqual(new Map([['unrelated', 'keep']]));
  });
});
