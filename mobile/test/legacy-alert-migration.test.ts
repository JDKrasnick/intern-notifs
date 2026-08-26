import { describe, expect, it, vi } from 'vitest';
import { legacyAlertMigrationPayload, migrateLegacyAccountAlerts } from '../src/legacy-alert-migration';

describe('legacy account alert migration', () => {
  const installation = { filter: {}, alertsEnabled: false, onboardingComplete: true };

  it('copies enabled legacy preferences to a disabled installation', () => {
    const legacy = {
      filter: { includeCategories: ['swe'] },
      alertsEnabled: true,
      onboardingComplete: true,
      alertSettings: { delivery: 'immediate' },
    };
    expect(legacyAlertMigrationPayload(installation, legacy)).toEqual(legacy);
  });

  it('does not overwrite an installation that already has alerts enabled', () => {
    expect(legacyAlertMigrationPayload(
      { ...installation, alertsEnabled: true },
      { ...installation, alertsEnabled: true },
    )).toBeUndefined();
  });

  it('does not migrate a disabled legacy preference', () => {
    expect(legacyAlertMigrationPayload(installation, installation)).toBeUndefined();
  });

  it('registers and saves before retiring the legacy account flag', async () => {
    const order: string[] = [];
    const legacy = { ...installation, alertsEnabled: true };
    await expect(migrateLegacyAccountAlerts({
      installation,
      legacyAccount: legacy,
      register: vi.fn(async () => { order.push('register'); return { status: 'registered' }; }),
      saveInstallation: vi.fn(async (value) => { order.push('save'); return value; }),
      retireLegacyAccount: vi.fn(async () => { order.push('retire'); }),
    })).resolves.toEqual(legacy);
    expect(order).toEqual(['register', 'save', 'retire']);
  });

  it('keeps the legacy flag when physical-device registration is unavailable', async () => {
    const retireLegacyAccount = vi.fn();
    await expect(migrateLegacyAccountAlerts({
      installation,
      legacyAccount: { ...installation, alertsEnabled: true },
      register: vi.fn(async () => ({ status: 'unsupported' })),
      saveInstallation: vi.fn(),
      retireLegacyAccount,
    })).resolves.toBeUndefined();
    expect(retireLegacyAccount).not.toHaveBeenCalled();
  });

  it('retires a legacy flag without re-registering when installation alerts already work', async () => {
    const register = vi.fn();
    const retireLegacyAccount = vi.fn(async () => undefined);
    await migrateLegacyAccountAlerts({
      installation: { ...installation, alertsEnabled: true },
      legacyAccount: { ...installation, alertsEnabled: true },
      register,
      saveInstallation: vi.fn(),
      retireLegacyAccount,
    });
    expect(register).not.toHaveBeenCalled();
    expect(retireLegacyAccount).toHaveBeenCalledOnce();
  });
});
