import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ShadowExtraction, ShadowStatus } from '../src/shadow-extraction.js';
import {
  evaluateShadowCase,
  parseShadowEvalCases,
  shadowEvalFields,
  shadowValuesMatch,
  summarizeShadowEval,
  type ShadowEvalCaseResult,
  type ShadowEvalExpected,
  type ShadowEvalFieldName,
  type ShadowEvalFieldResult,
} from '../src/shadow-extraction-eval.js';

function field(status: ShadowStatus, value?: unknown) {
  return { value: status === 'present' ? (value ?? null) : null, status, evidence: status === 'present' ? ['evidence'] : [], qualifiers: [] };
}

function extraction(fields: Partial<Record<ShadowEvalFieldName, { status: ShadowStatus; value?: unknown }>> = {}): ShadowExtraction {
  const all = {} as ShadowExtraction['fields'];
  for (const name of shadowEvalFields) {
    const entry = fields[name];
    all[name] = entry ? field(entry.status, entry.value) : field('not-stated');
  }
  return { classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software engineering'] }, fields: all };
}

function expected(fields: Partial<Record<ShadowEvalFieldName, { status: ShadowStatus; value?: unknown }>>): ShadowEvalExpected {
  const entries = Object.fromEntries(Object.entries(fields).map(([name, entry]) => {
    const label: ShadowEvalExpected['fields'][ShadowEvalFieldName] = { status: entry.status };
    if (entry.status === 'present') label.value = entry.value;
    return [name, label];
  })) as ShadowEvalExpected['fields'];
  return { classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software engineering'] }, fields: entries };
}

const verdictOf = (results: ReturnType<typeof evaluateShadowCase>, name: ShadowEvalFieldName) =>
  results.fields.find((entry) => entry.field === name)?.verdict;

describe('parseShadowEvalCases', () => {
  it('rejects malformed envelopes', () => {
    expect(() => parseShadowEvalCases(null)).toThrow(/version 1/);
    expect(() => parseShadowEvalCases({ version: 2, cases: [] })).toThrow(/version 1/);
    expect(() => parseShadowEvalCases({ version: 1, cases: [] })).toThrow(/non-empty array/);
  });
  it('rejects invalid case fields with the case id named', () => {
    const base = { id: 'x', title: 'Title', description: 'Body', expected: { classification: { technical: 'yes', earlyCareer: 'yes', disciplines: [] }, fields: {} } };
    expect(() => parseShadowEvalCases({ version: 1, cases: [base, { ...base, id: 'x' }] })).toThrow(/x.*duplicated/);
    expect(() => parseShadowEvalCases({ version: 1, cases: [{ ...base, expected: { ...base.expected, fields: { compensation: { status: 'banana' } } } }] })).toThrow(/status is invalid/);
    expect(() => parseShadowEvalCases({ version: 1, cases: [{ ...base, expected: { ...base.expected, fields: { compensation: { status: 'present' } } } }] })).toThrow(/present without a value/);
    expect(() => parseShadowEvalCases({ version: 1, cases: [{ ...base, expected: { ...base.expected, fields: { housing: { status: 'not-stated', value: 1 } } } }] })).toThrow(/has a value/);
    expect(() => parseShadowEvalCases({ version: 1, cases: [{ ...base, expected: { ...base.expected, classification: { technical: 'maybe', earlyCareer: 'yes', disciplines: [] } } }] })).toThrow(/technical/);
    expect(() => parseShadowEvalCases({ version: 1, cases: [{ ...base, expected: { ...base.expected, fields: { mystery: { status: 'not-stated' } } } }] })).toThrow(/unknown field key/);
  });
});

describe('evaluateShadowCase verdict matrix', () => {
  it('produces true-positive for a matching present field', () => {
    const label = expected({ compensation: { status: 'present', value: [{ min: 10, max: 20, currency: 'USD', period: 'hour' }] } });
    const result = evaluateShadowCase(extraction({ compensation: { status: 'present', value: [{ min: 10, max: 20, currency: 'USD', period: 'hour' }] } }), label);
    expect(verdictOf(result, 'compensation')).toBe('true-positive');
  });
  it('produces unsupported-claim when the model claims an absent field', () => {
    const label = expected({ workMode: { status: 'not-stated' } });
    const result = evaluateShadowCase(extraction({ workMode: { status: 'present', value: 'remote' } }), label);
    expect(verdictOf(result, 'workMode')).toBe('unsupported-claim');
  });
  it('produces value-mismatch when a present value differs', () => {
    const label = expected({ locations: { status: 'present', value: ['Boston, MA'] } });
    const result = evaluateShadowCase(extraction({ locations: { status: 'present', value: ['Boston, MA', 'New York, NY'] } }), label);
    expect(verdictOf(result, 'locations')).toBe('value-mismatch');
  });
  it('produces false-negative when a disclosed field is missed', () => {
    const label = expected({ education: { status: 'present', value: true } });
    const result = evaluateShadowCase(extraction({ education: { status: 'not-stated' } }), label);
    expect(verdictOf(result, 'education')).toBe('false-negative');
  });
  it('produces true-negative when both agree a field is absent', () => {
    const label = expected({ housing: { status: 'not-stated' } });
    const result = evaluateShadowCase(extraction({ housing: { status: 'not-stated' } }), label);
    expect(verdictOf(result, 'housing')).toBe('true-negative');
  });
  it('labels only fields named in the expectation', () => {
    const label = expected({ compensation: { status: 'not-stated' } });
    const result = evaluateShadowCase(extraction(), label);
    expect(result.fields.map((entry) => entry.field)).toEqual(['compensation']);
  });
});

describe('shadowValuesMatch', () => {
  const band = { min: 50, max: 60, currency: 'USD', period: 'hour' };
  it('compares compensation bands as an order-independent set', () => {
    expect(shadowValuesMatch('compensation', [band, { min: 45, max: 45, currency: 'USD', period: 'hour' }], [{ min: 45, max: 45, currency: 'USD', period: 'hour' }, band])).toBe(true);
    expect(shadowValuesMatch('compensation', [{ ...band, max: 70 }], [band])).toBe(false);
    expect(shadowValuesMatch('compensation', 'not-a-band', [band])).toBe(false);
  });
  it('normalizes locations case and whitespace and rejects missing items', () => {
    expect(shadowValuesMatch('locations', ['  Boston,   MA '], ['boston, ma'])).toBe(true);
    expect(shadowValuesMatch('locations', ['Boston, MA'], ['Boston, MA', 'New York, NY'])).toBe(false);
    expect(shadowValuesMatch('locations', 'Boston', ['Boston'])).toBe(false);
  });
  it('compares workMode case-insensitively', () => {
    expect(shadowValuesMatch('workMode', ' Remote ', 'remote')).toBe(true);
    expect(shadowValuesMatch('workMode', 'hybrid', 'onsite')).toBe(false);
  });
  it('treats housing, timing, education, and eligibility as status-only', () => {
    for (const name of ['housing', 'timing', 'education', 'eligibility'] as const) {
      expect(shadowValuesMatch(name, { any: 'shape' }, true)).toBe(true);
    }
  });
});

describe('summarizeShadowEval', () => {
  const result = (fields: ShadowEvalFieldResult[], classification: ShadowEvalCaseResult['classification'], cost?: ShadowEvalCaseResult['cost'], valid = true): ShadowEvalCaseResult =>
    ({ id: `r${Math.random()}`, valid, failures: [], fields: fields ?? [], classification, ...(cost ? { cost } : {}) });
  it('aggregates known verdict counts into the exact rates', () => {
    const summary = summarizeShadowEval([
      result([{ field: 'compensation', predictedStatus: 'present', expectedStatus: 'present', verdict: 'true-positive' }],
        { technical: true, earlyCareer: false, disciplines: true }, { inputTokens: 10, outputTokens: 20, actualCostCents: 1 }),
      result([{ field: 'compensation', predictedStatus: 'present', expectedStatus: 'not-stated', verdict: 'unsupported-claim' }],
        { technical: true, earlyCareer: true, disciplines: false }),
      result([{ field: 'workMode', predictedStatus: 'present', expectedStatus: 'present', verdict: 'value-mismatch' },
        { field: 'housing', predictedStatus: 'not-stated', expectedStatus: 'not-stated', verdict: 'true-negative' }],
        { technical: false, earlyCareer: true, disciplines: true }),
    ]);
    expect(summary.cases).toBe(3);
    expect(summary.validCases).toBe(3);
    expect(summary.invalidCases).toBe(0);
    expect(summary.fieldCounts.compensation.truePositive).toBe(1);
    expect(summary.fieldCounts.compensation.unsupportedClaim).toBe(1);
    expect(summary.fieldCounts.workMode.valueMismatch).toBe(1);
    expect(summary.fieldCounts.housing.trueNegative).toBe(1);
    expect(summary.precision).toBeCloseTo(1 / 3);
    expect(summary.recall).toBeCloseTo(0.5);
    expect(summary.unsupportedClaimRate).toBeCloseTo(1 / 3);
    expect(summary.valueMismatchRate).toBeCloseTo(1 / 3);
    expect(summary.classification.technical.correct).toBe(2);
    expect(summary.classification.technical.total).toBe(3);
    expect(summary.classification.disciplines.correct).toBe(2);
    expect(summary.cost.inputTokens).toBe(10);
    expect(summary.cost.avgCostCentsPerCase).toBe(1);
  });
  it('reports null rates and zero cost when no present predictions exist', () => {
    const summary = summarizeShadowEval([
      result([{ field: 'eligibility', predictedStatus: 'not-stated', expectedStatus: 'not-stated', verdict: 'true-negative' }], undefined),
    ]);
    expect(summary.precision).toBeNull();
    expect(summary.recall).toBeNull();
    expect(summary.unsupportedClaimRate).toBeNull();
    expect(summary.valueMismatchRate).toBeNull();
    expect(summary.cost.avgCostCentsPerCase).toBeNull();
    expect(summary.cost.actualCostCents).toBe(0);
  });
  it('excludes invalid results from every metric', () => {
    const summary = summarizeShadowEval([
      result([{ field: 'workMode', predictedStatus: 'present', expectedStatus: 'present', verdict: 'true-positive' }], undefined),
      result([], undefined, undefined, false),
    ]);
    expect(summary.cases).toBe(2);
    expect(summary.validCases).toBe(1);
    expect(summary.invalidCases).toBe(1);
    expect(summary.fieldCounts.workMode.truePositive).toBe(1);
    expect(summary.precision).toBe(1);
  });
});

describe('golden dataset fixture', () => {
  const dataset = parseShadowEvalCases(JSON.parse(readFileSync(new URL('../test/fixtures/shadow-extraction-eval.json', import.meta.url), 'utf8')) as unknown);
  it('loads 11 cases with unique ids and all seven explicit field labels', () => {
    expect(dataset.length).toBe(11);
    expect(new Set(dataset.map((entry) => entry.id)).size).toBe(11);
    for (const entry of dataset) expect(Object.keys(entry.expected.fields).sort()).toEqual([...shadowEvalFields].sort());
  });
  it('keeps the sw-intern compensation expectation canonical', () => {
    const entry = dataset.find((item) => item.id === 'sw-intern-pay-location-onsite');
    expect(entry?.expected.fields.compensation?.value).toEqual([{ min: 50, max: 60, currency: 'USD', period: 'hour' }]);
  });
});

describe('second golden dataset fixture (anti-overfit holdout)', () => {
  const dataset = parseShadowEvalCases(JSON.parse(readFileSync(new URL('../test/fixtures/shadow-extraction-eval-2.json', import.meta.url), 'utf8')) as unknown);
  it('loads 12 unique cases with all seven explicit field labels', () => {
    expect(dataset.length).toBe(12);
    expect(new Set(dataset.map((entry) => entry.id)).size).toBe(12);
    for (const entry of dataset) expect(Object.keys(entry.expected.fields).sort()).toEqual([...shadowEvalFields].sort());
  });
  it('keeps the CAD new-grad compensation and work-mode conflict expectations', () => {
    const cad = dataset.find((item) => item.id === 'cad-new-grad-hybrid');
    expect(cad?.expected.fields.compensation?.value).toEqual([{ min: 85000, max: 85000, currency: 'CAD', period: 'year' }]);
    const conflict = dataset.find((item) => item.id === 'conflicting-work-mode');
    expect(conflict?.expected.fields.workMode?.status).toBe('conflicting');
    expect(conflict?.expected.classification.earlyCareer).toBe('yes');
  });
  it('keeps the senior experienced-hire earlyCareer label', () => {
    const senior = dataset.find((item) => item.id === 'senior-experienced-hire');
    expect(senior?.expected.classification.earlyCareer).toBe('no');
  });
});
