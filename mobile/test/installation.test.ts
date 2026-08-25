import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  api: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { mocks.values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { mocks.values.delete(key); }),
  },
}));
vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, api: mocks.api };
});

import { installationApi } from '../src/installation';

beforeEach(() => {
  mocks.values.clear();
  mocks.api.mockReset();
});

describe('installation-scoped settings', () => {
  it('creates one anonymous installation and reuses it for settings writes', async () => {
    mocks.api
      .mockResolvedValueOnce({ token: 'installation-token' })
      .mockResolvedValueOnce({ alertsEnabled: true });

    await expect(installationApi('/preferences', { method: 'PUT', body: '{}' }))
      .resolves.toEqual({ alertsEnabled: true });
    expect(mocks.api).toHaveBeenNthCalledWith(1, '/installations', '', { method: 'POST' });
    expect(mocks.api).toHaveBeenNthCalledWith(2, '/installation/preferences', 'installation-token', { method: 'PUT', body: '{}' });
  });
});
