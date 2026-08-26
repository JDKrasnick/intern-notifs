export function legacyAlertMigrationPayload<T extends {
  alertsEnabled: boolean;
  onboardingComplete: boolean;
}>(installation: T, legacyAccount: T): T | undefined {
  if (installation.alertsEnabled || !legacyAccount.alertsEnabled) return undefined;
  return {
    ...legacyAccount,
    alertsEnabled: true,
    onboardingComplete: true,
  };
}

export async function migrateLegacyAccountAlerts<T extends {
  alertsEnabled: boolean;
  onboardingComplete: boolean;
}>(input: {
  installation: T;
  legacyAccount: T;
  register: () => Promise<{ status: string }>;
  saveInstallation: (preferences: T) => Promise<T>;
  retireLegacyAccount: () => Promise<unknown>;
}): Promise<T | undefined> {
  if (!input.legacyAccount.alertsEnabled) return undefined;
  const migration = legacyAlertMigrationPayload(input.installation, input.legacyAccount);
  let updated: T | undefined;
  if (migration) {
    const registration = await input.register();
    if (registration.status !== 'registered') return undefined;
    updated = await input.saveInstallation(migration);
  }
  await input.retireLegacyAccount();
  return updated;
}
