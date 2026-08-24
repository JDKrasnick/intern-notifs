import AsyncStorage from '@react-native-async-storage/async-storage';
import { publicConfig } from './public-config';

const baseUrl = publicConfig.apiUrl.replace(/\/$/, '');
const requestTimeoutMs = 12_000;
const readRetryDelaysMs = [250, 500, 1_000];
const retryableReadStatuses = new Set([429, 502, 503, 504]);
const idTokenStorageKey = 'internnotifs.idToken';
const authSessionStorageKey = 'internnotifs.authSession';

export type StoredAuthSession = { idToken: string; refreshToken: string; username: string };

function cognitoStoragePrefix() {
  return `@MemoryStorage:CognitoIdentityServiceProvider.${publicConfig.cognitoClientId}`;
}

function isReadRequest(init: RequestInit) {
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchOnce(path: string, token: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The request timed out. Check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_API_URL is not configured');
  let response = await fetchOnce(path, token, init);
  if (isReadRequest(init)) {
    for (const delay of readRetryDelaysMs) {
      if (!retryableReadStatuses.has(response.status)) break;
      await wait(delay);
      response = await fetchOnce(path, token, init);
    }
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? 'Request failed');
  return data;
}

export const sessionStorage = {
  get: () => AsyncStorage.getItem(idTokenStorageKey),
  set: (token: string) => AsyncStorage.setItem(idTokenStorageKey, token),
  getRefreshable: async () => {
    const value = await AsyncStorage.getItem(authSessionStorageKey);
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as { idToken?: unknown; refreshToken?: unknown; username?: unknown };
      if (typeof parsed.idToken !== 'string' || typeof parsed.refreshToken !== 'string' || typeof parsed.username !== 'string') return undefined;
      return { idToken: parsed.idToken, refreshToken: parsed.refreshToken, username: parsed.username };
    } catch {
      return undefined;
    }
  },
  getCognitoCached: async (): Promise<StoredAuthSession | undefined> => {
    if (!publicConfig.cognitoClientId) return undefined;
    const prefix = cognitoStoragePrefix();
    const username = await AsyncStorage.getItem(`${prefix}.LastAuthUser`);
    if (!username) return undefined;
    const [idToken, refreshToken] = await Promise.all([
      AsyncStorage.getItem(`${prefix}.${username}.idToken`),
      AsyncStorage.getItem(`${prefix}.${username}.refreshToken`),
    ]);
    if (!idToken || !refreshToken) return undefined;
    return { idToken, refreshToken, username };
  },
  setRefreshable: async (value: StoredAuthSession) => {
    await Promise.all([
      AsyncStorage.setItem(idTokenStorageKey, value.idToken),
      AsyncStorage.setItem(authSessionStorageKey, JSON.stringify(value)),
    ]);
  },
  clear: async () => {
    const keys = [idTokenStorageKey, authSessionStorageKey];
    if (publicConfig.cognitoClientId) {
      const prefix = `${cognitoStoragePrefix()}.`;
      const cognitoKeys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
      keys.push(...cognitoKeys);
    }
    await AsyncStorage.multiRemove(keys);
  },
};

/** Public catalog responses are safe to retain locally for a fast first view. */
export const responseCache = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await AsyncStorage.getItem(key);
      return value ? JSON.parse(value) as T : undefined;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The live catalog remains fully usable when device storage is unavailable.
    }
  },
};
