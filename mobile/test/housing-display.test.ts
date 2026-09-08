import { describe, expect, it } from 'vitest';
import { housingLabels } from '../../shared/housing-display.js';

describe('housing display', () => {
  it('distinguishes support from costs and does not imply provided housing is free', () => {
    expect(housingLabels([
      { kind: 'stipend', minAmount: 2500, maxAmount: 2500, currency: 'USD', period: 'monthly', sourceText: 'Monthly housing stipend.' },
      { kind: 'employee-cost', minAmount: 400, maxAmount: 600, currency: 'EUR', period: 'monthly', sourceText: 'Interns pay rent.' },
      { kind: 'employer-paid', sourceText: 'Free housing.' },
      { kind: 'available', sourceText: 'Housing is available.' },
    ]).map(item => item.label)).toEqual(['Housing stipend: USD 2,500/month', 'Housing cost to you: EUR 400–600/month',
      'Employer-paid housing', 'Housing available · cost not confirmed']);
  });
  it('preserves conditional wording and unknown units without inventing an amount', () => {
    expect(housingLabels([{ kind: 'stipend', conditional: true, sourceText: 'Up to $2,500, subject to eligibility.' }]))
      .toEqual([{ label: 'Housing stipend · conditional', detail: 'Up to $2,500, subject to eligibility.' }]);
    expect(housingLabels([{ kind: 'employee-cost', minAmount: 500, maxAmount: 500, sourceText: 'Housing costs $500.' }])[0]?.label)
      .toBe('Housing cost to you: $500 · period not stated');
    expect(housingLabels([{ kind: 'employee-cost', minAmount: 500, maxAmount: 500, sourceText: 'Housing costs 500.' }])[0]?.label)
      .toBe('Housing cost to you: Currency not stated 500 · period not stated');
    expect(housingLabels(undefined)).toEqual([]);
  });
});
