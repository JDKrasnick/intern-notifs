import AsyncStorage from '@react-native-async-storage/async-storage';
import { publicConfig } from './public-config';

const idTokenStorageKey = 'internnotifs.idToken';
const authSessionStorageKey = 'internnotifs.authSession';

export type StoredAuthSession = { idToken: string; refreshToken: string; username: string };

function cognitoStoragePrefix() {
  return `@MemoryStorage:CognitoIdentityServiceProvider.${publicConfig.cognitoClientId}`;
}

export const sessionStorage = {
  get: () => AsyncStorage.getItem(idTokenStorageKey),
  set: (token: string) => AsyncStorage.setItem(idTokenStorageKey, token),
  clearLegacy: () => AsyncStorage.removeItem(idTokenStorageKey),
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
