import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  isAvailable: vi.fn(),
  share: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: mocks.isAvailable, shareAsync: mocks.share }));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri = 'file:///cache/internnotifs-data-2026-08-26.json';
    create = mocks.create;
    write = mocks.write;
    delete = mocks.delete;
  },
}));

import { shareDataExport } from '../src/account-data-share';

const exported = {
  schemaVersion: 1,
  exportedAt: '2026-08-26T12:00:00.000Z',
  account: { profile: null, applications: [], documents: [] },
  currentInstallation: { preferences: { alertsEnabled: true } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
});

describe('native account export sharing', () => {
  it('treats share-sheet cancellation as a completed share attempt', async () => {
    mocks.isAvailable.mockResolvedValue(true);
    mocks.share.mockResolvedValue(undefined);
    await expect(shareDataExport(exported)).resolves.toBeUndefined();
    expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    expect(mocks.share).toHaveBeenCalledWith(expect.stringMatching(/internnotifs-data-2026-08-26\.json$/), expect.objectContaining({ mimeType: 'application/json' }));
    expect(mocks.delete).toHaveBeenCalledOnce();
  });

  it('deletes the temporary export when sharing fails', async () => {
    mocks.isAvailable.mockResolvedValue(true);
    mocks.share.mockRejectedValue(new Error('share failed'));
    await expect(shareDataExport(exported)).rejects.toThrow('share failed');
    expect(mocks.delete).toHaveBeenCalledOnce();
  });

  it('reports unavailable sharing before writing a temporary file', async () => {
    mocks.isAvailable.mockResolvedValue(false);
    await expect(shareDataExport(exported)).rejects.toMatchObject({ name: 'SharingUnavailableError' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
