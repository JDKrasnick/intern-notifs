import AsyncStorage from '@react-native-async-storage/async-storage';

const baseUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '');
export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new Error('EXPO_PUBLIC_API_URL is not configured');
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
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
