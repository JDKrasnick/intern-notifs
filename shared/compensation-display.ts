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
    const isKnownCurrency = /^[A-Z]{3}$/u.test(range.currency) && range.currency !== 'XXX';
    let currencyPrefix = '';
    if (isKnownCurrency) {
      currencyPrefix = `${range.currency} `;
    } else {
      // XXX or missing currency: infer symbol from sourceText for UX, never show "Currency not stated"
      const src = range.sourceText ?? '';
      if (src.includes('€')) currencyPrefix = '€';
      else if (src.includes('£')) currencyPrefix = '£';
      else if (src.includes('$')) currencyPrefix = '$';
      else if (src.includes('¥')) currencyPrefix = '¥';
      // otherwise no currency prefix, just amount
    }
    const period: Record<string, string> = { hourly: '/hour', daily: '/day', weekly: '/week', monthly: '/month', annual: '/year', unknown: ' · period not stated', other: ' · see employer pay terms' };
    const amount = `${number(range.minAmount)}${range.maxAmount !== range.minAmount ? `–${number(range.maxAmount)}` : ''}`;
    const applicability = [range.applicabilityLabel, ...(range.applicableLocations ?? []), ...(range.applicableEducationLevels ?? [])].filter(Boolean).join(', ');
    const interval = range.period === 'other' && range.periodLabel ? ` · ${range.periodLabel}` : period[range.period] ?? ' · period not stated';
    const amountWithCurrency = `${currencyPrefix}${amount}${interval}`;
    return [`${amountWithCurrency}${applicability ? ` (${applicability})` : ''}`];
  });
  // Fallback to raw, but hide stale "Currency not stated" phrasing if it leaked through stored data
  const rawFallback = typeof value?.raw === 'string' && value.raw.trim() ? value.raw.trim().slice(0, 160) : '';
  if (labels.length) return [...new Set(labels)];
  if (rawFallback && rawFallback.includes('Currency not stated')) {
    // Try to salvage amount from raw: e.g. "Currency not stated 54/hour" -> "54/hour" or "$54/hour" if raw has $
    const cleaned = rawFallback.replace(/^Currency not stated\s*/u, '');
    if (cleaned) return [cleaned];
    // fallback to just hide phrase
    return [rawFallback.replace('Currency not stated', '').trim() || 'Pay disclosed: see details'];
  }
  return rawFallback ? [rawFallback] : [];
}
