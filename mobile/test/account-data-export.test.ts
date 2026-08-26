import { describe, expect, it, vi } from 'vitest';
import { buildCompleteDataExport, dataExportFileName, serializeDataExport, type AccountExportResponse } from '../src/account-data-export';

const account: AccountExportResponse = {
  schemaVersion: 1,
  exportedAt: '2026-08-26T12:00:00.000Z',
  account: { profile: null, applications: [], documents: [] },
};

describe('mobile account data export', () => {
  it('merges account data with sanitized current-installation preferences and readable JSON', async () => {
    const result = await buildCompleteDataExport({
      fetchAccount: vi.fn().mockResolvedValue(account),
      fetchInstallationPreferences: vi.fn().mockResolvedValue({ userId: 'installation-secret-id', alertsEnabled: true, filter: { includeCategories: ['swe'] } }),
    });
    expect(result).toEqual({ ...account, currentInstallation: { preferences: { alertsEnabled: true, filter: { includeCategories: ['swe'] } } } });
    const serialized = serializeDataExport(result);
    expect(serialized).toContain('\n  "schemaVersion": 1');
    expect(serialized).not.toContain('installation-secret-id');
    expect(JSON.parse(serialized)).toEqual(result);
    expect(dataExportFileName(result.exportedAt)).toBe('internnotifs-data-2026-08-26.json');
  });

  it.each([
    ['account', true, false],
    ['installation', false, true],
    ['neither', false, false],
  ] as const)('reports a %s-only partial fetch and never produces a shareable export', async (completed, accountSucceeds, installationSucceeds) => {
    await expect(buildCompleteDataExport({
      fetchAccount: () => accountSucceeds ? Promise.resolve(account) : Promise.reject(new Error('account failed')),
      fetchInstallationPreferences: () => installationSucceeds ? Promise.resolve({ alertsEnabled: true }) : Promise.reject(new Error('installation failed')),
    })).rejects.toEqual(expect.objectContaining({ name: 'DataExportFetchError', completed }));
  });
});
