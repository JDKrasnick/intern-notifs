/** Browser-safe, dependency-free formatter shared by catalog projection and UI. */
export interface DisplayCompensation {
  raw?: unknown;
  ranges?: readonly { minAmount: number; maxAmount: number; currency: string; period: string;
    applicabilityLabel?: string;
    periodLabel?: string;
    applicableLocations?: readonly string[]; applicableEducationLevels?: readonly string[]; sourceText?: string }[];
}

export function compensationLabels(value: DisplayCompensation | undefined): string[] {
  const labels = (value?.ranges ?? []).slice(0, 24).flatMap((range) => {
    if (!Number.isFinite(range.minAmount) || !Number.isFinite(range.maxAmount) || range.minAmount <= 0 || range.maxAmount < range.minAmount) return [];
    const number = (amount: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount);
    const currency = /^[A-Z]{3}$/u.test(range.currency) && range.currency !== 'XXX' ? range.currency : 'Currency not stated';
    const period: Record<string, string> = { hourly: '/hour', daily: '/day', weekly: '/week', monthly: '/month', annual: '/year', unknown: ' · period not stated', other: ' · see employer pay terms' };
    const amount = `${number(range.minAmount)}${range.maxAmount !== range.minAmount ? `–${number(range.maxAmount)}` : ''}`;
    const applicability = [range.applicabilityLabel, ...(range.applicableLocations ?? []), ...(range.applicableEducationLevels ?? [])].filter(Boolean).join(', ');
    const interval = range.period === 'other' && range.periodLabel ? ` · ${range.periodLabel}` : period[range.period] ?? ' · period not stated';
    return [`${currency} ${amount}${interval}${applicability ? ` (${applicability})` : ''}`];
  });
  return labels.length ? [...new Set(labels)] : typeof value?.raw === 'string' && value.raw.trim() ? [value.raw.trim().slice(0, 160)] : [];
}
