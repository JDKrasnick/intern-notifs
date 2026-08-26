import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api } from './api';

const installationTokenKey = 'internnotifs.installation-token.v1';
let creationInFlight: Promise<string> | undefined;

async function createInstallation(): Promise<string> {
  const created = await api<{ token: string }>('/installations', '', { method: 'POST' });
  await AsyncStorage.setItem(installationTokenKey, created.token);
  return created.token;
}

export async function installationToken(): Promise<string> {
  const stored = await AsyncStorage.getItem(installationTokenKey);
  if (stored) return stored;
  creationInFlight ??= createInstallation().finally(() => { creationInFlight = undefined; });
  return creationInFlight;
}

export async function installationApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = await installationToken();
  try {
    return await api<T>(`/installation${path}`, token, init);
  } catch (error) {
    if (!(error instanceof ApiError) || error.kind !== 'unauthorized') throw error;
  }
  await AsyncStorage.removeItem(installationTokenKey);
  token = await installationToken();
  return api<T>(`/installation${path}`, token, init);
}
