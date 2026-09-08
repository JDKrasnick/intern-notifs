import { compensationLabels } from './compensation-display';

export interface DisplayHousingDetail {
  kind: 'stipend' | 'employer-paid' | 'employee-cost' | 'available';
  minAmount?: number;
  maxAmount?: number;
  currency?: string;
  period?: string;
  periodLabel?: string;
  conditional?: boolean;
  sourceText: string;
}

/** Keep the employer's conditions beside the amount, separate from base pay. */
export function housingLabels(details: readonly DisplayHousingDetail[] | undefined): Array<{ label: string; detail: string }> {
  const names = { stipend: 'Housing stipend', 'employer-paid': 'Employer-paid housing',
    'employee-cost': 'Housing cost to you', available: 'Housing available · cost not confirmed' };
  return (details ?? []).slice(0, 8).flatMap(item => {
    if (!Object.hasOwn(names, item.kind)) return [];
    const amount = item.minAmount !== undefined && item.maxAmount !== undefined ? compensationLabels({ ranges: [{
      minAmount: item.minAmount, maxAmount: item.maxAmount, currency: item.currency ?? 'XXX',
      period: item.period ?? 'unknown', periodLabel: item.periodLabel, sourceText: item.sourceText,
    }] })[0] : undefined;
    return [{ label: `${names[item.kind]}${amount ? `: ${amount}` : ''}${item.conditional ? ' · conditional' : ''}`,
      detail: typeof item.sourceText === 'string' ? [...item.sourceText.trim()].slice(0, 240).join('') : '' }];
  });
}
