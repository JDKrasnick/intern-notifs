import AsyncStorage from '@react-native-async-storage/async-storage';
import { publicConfig } from './public-config';

const baseUrl = publicConfig.apiUrl.replace(/\/$/, '');
const requestTimeoutMs = 12_000;

export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_API_URL is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
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
  if (response.status === 204) return undefined as T;
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? 'Request failed');
  return data;
}

export const sessionStorage = {
  get: () => AsyncStorage.getItem('internnotifs.idToken'),
  set: (token: string) => AsyncStorage.setItem('internnotifs.idToken', token),
  clear: () => AsyncStorage.removeItem('internnotifs.idToken')
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
