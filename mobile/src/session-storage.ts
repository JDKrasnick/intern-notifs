import AsyncStorage from '@react-native-async-storage/async-storage';

const tokenStorageKey = 'internnotifs.idToken';
const authSessionStorageKey = 'internnotifs.authSession';

export type StoredAuthSession = { token: string; expiresAt: string; username: string };

export const sessionStorage = {
  get: () => AsyncStorage.getItem(tokenStorageKey),
  set: (token: string) => AsyncStorage.setItem(tokenStorageKey, token),
  clearLegacy: () => AsyncStorage.removeItem(tokenStorageKey),
  getSession: async (): Promise<StoredAuthSession | undefined> => {
    const value = await AsyncStorage.getItem(authSessionStorageKey);
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as { token?: unknown; expiresAt?: unknown; username?: unknown };
      if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string' || typeof parsed.username !== 'string') return undefined;
      return { token: parsed.token, expiresAt: parsed.expiresAt, username: parsed.username };
    } catch {
      return undefined;
    }
  },
  setSession: async (value: StoredAuthSession) => {
    await Promise.all([
      AsyncStorage.setItem(tokenStorageKey, value.token),
      AsyncStorage.setItem(authSessionStorageKey, JSON.stringify(value)),
    ]);
  },
  clear: async () => {
    const cognitoKeys = (await AsyncStorage.getAllKeys()).filter((key) => key.includes('CognitoIdentityServiceProvider.'));
    await AsyncStorage.multiRemove([tokenStorageKey, authSessionStorageKey, ...cognitoKeys]);
  },
};
