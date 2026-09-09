import { isRecord } from './shadow-extraction.js';
import type { ClassificationLabel, ShadowExtraction, ShadowStatus } from './shadow-extraction.js';

/**
 * Pure evaluation of shadow-extraction runs against an expected golden dataset.
 * Node-safe by design: imports types and the canonical record guard only,
 * performs no Cloudflare or network work, and is shared by the CLI runner,
 * offline replay, and unit tests.
 */

export const shadowEvalFields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'] as const;
export type ShadowEvalFieldName = (typeof shadowEvalFields)[number];

export interface ShadowEvalExpectedField {
  status: ShadowStatus;
  value?: unknown;
}

export interface ShadowEvalExpected {
  classification: { technical: ClassificationLabel; earlyCareer: ClassificationLabel; disciplines: string[] };
  fields: Partial<Record<ShadowEvalFieldName, ShadowEvalExpectedField>>;
}

export interface ShadowEvalCase {
  id: string;
  title: string;
  description: string;
  expected: ShadowEvalExpected;
}

export type ShadowEvalVerdict = 'true-positive' | 'unsupported-claim' | 'value-mismatch' | 'false-negative' | 'true-negative';

export interface ShadowEvalFieldResult {
  field: ShadowEvalFieldName;
  predictedStatus: ShadowStatus;
  expectedStatus: ShadowStatus;
  verdict: ShadowEvalVerdict;
}

export interface ShadowEvalClassificationResult {
  technical: boolean;
  earlyCareer: boolean;
  disciplines: boolean;
}

export interface ShadowEvalCaseResult {
  id: string;
  valid: boolean;
  failures: string[];
  error?: string;
  classification?: ShadowEvalClassificationResult;
  fields: ShadowEvalFieldResult[];
  cost?: { inputTokens: number; outputTokens: number; actualCostCents: number };
}

export interface ShadowRecordedRun {
  id: string;
  contentHash: string;
  result: { response: unknown; inputTokens: number; outputTokens: number; actualCostCents: number };
}

export interface ShadowRecordedFixture {
  version: 1;
  recordedAt: string;
  modelId: string;
  cases: ShadowRecordedRun[];
}

export interface FieldVerdictCounts {
  truePositive: number;
  unsupportedClaim: number;
  valueMismatch: number;
  falseNegative: number;
  trueNegative: number;
}

export interface ShadowEvalSummary {
  cases: number;
  validCases: number;
  invalidCases: number;
  classification: {
    technical: { correct: number; total: number };
    earlyCareer: { correct: number; total: number };
    disciplines: { correct: number; total: number };
  };
  fieldCounts: Record<ShadowEvalFieldName, FieldVerdictCounts>;
  precision: number | null;
  recall: number | null;
  unsupportedClaimRate: number | null;
  valueMismatchRate: number | null;
  cost: { inputTokens: number; outputTokens: number; actualCostCents: number; avgCostCentsPerCase: number | null };
}

function canonicalCompensationBands(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bands: string[] = [];
  for (const band of value) {
    if (!isRecord(band) || !Number.isFinite(band.min as number) || !Number.isFinite(band.max as number)
      || typeof band.currency !== 'string' || typeof band.period !== 'string') return undefined;
    bands.push(`${band.min}|${band.max}|${band.currency}|${band.period}`);
  }
  return bands.sort();
}

function canonicalLocations(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return (value as string[]).map((entry) => entry.trim().replace(/\s+/gu, ' ').toLowerCase()).sort();
}

/** Value comparison for the three publishable fields; the remaining fields are
 * status-only in the current prompt contract, so any present value matches. */
export function shadowValuesMatch(field: ShadowEvalFieldName, predicted: unknown, expected: unknown): boolean {
  if (field === 'compensation') {
    const actual = canonicalCompensationBands(predicted);
    const want = canonicalCompensationBands(expected);
    if (actual === undefined || want === undefined) return false;
    return actual.length === want.length && actual.every((band, index) => band === want[index]);
  }
  if (field === 'locations') {
    const actual = canonicalLocations(predicted);
    const want = canonicalLocations(expected);
    if (actual === undefined || want === undefined) return false;
    return actual.length === want.length && actual.every((entry, index) => entry === want[index]);
  }
  if (field === 'workMode') {
    return String(predicted).trim().toLowerCase() === String(expected).trim().toLowerCase();
  }
  return true;
}

function disciplinesMatch(predicted: readonly string[], expected: readonly string[]): boolean {
  const normalized = (entries: readonly string[]) => [...new Set(entries.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0))];
  const actual = normalized(predicted);
  const want = normalized(expected);
  return actual.length === want.length && actual.every((entry) => want.includes(entry));
}

export function evaluateShadowCase(extraction: ShadowExtraction, expected: ShadowEvalExpected): {
  classification: ShadowEvalClassificationResult;
  fields: ShadowEvalFieldResult[];
} {
  const classification = {
    technical: extraction.classification.technical === expected.classification.technical,
    earlyCareer: extraction.classification.earlyCareer === expected.classification.earlyCareer,
    disciplines: disciplinesMatch(extraction.classification.disciplines, expected.classification.disciplines),
  };
  const fields: ShadowEvalFieldResult[] = [];
  for (const [field, label] of Object.entries(expected.fields) as Array<[ShadowEvalFieldName, ShadowEvalExpectedField]>) {
    const predicted = extraction.fields[field];
    if (!predicted) throw new Error(`Extraction is missing field ${field}`);
    let verdict: ShadowEvalVerdict;
    if (label.status === 'present') {
      if (predicted.status === 'present' && shadowValuesMatch(field, predicted.value, label.value)) verdict = 'true-positive';
      else if (predicted.status === 'present') verdict = 'value-mismatch';
      else verdict = 'false-negative';
    } else if (predicted.status === 'present') {
      verdict = 'unsupported-claim';
    } else {
      verdict = 'true-negative';
    }
    fields.push({ field, predictedStatus: predicted.status, expectedStatus: label.status, verdict });
  }
  return { classification, fields };
}

export function summarizeShadowEval(results: readonly ShadowEvalCaseResult[]): ShadowEvalSummary {
  const fieldCounts = {} as Record<ShadowEvalFieldName, FieldVerdictCounts>;
  for (const field of shadowEvalFields) {
    fieldCounts[field] = { truePositive: 0, unsupportedClaim: 0, valueMismatch: 0, falseNegative: 0, trueNegative: 0 };
  }
  const classification = {
    technical: { correct: 0, total: 0 },
    earlyCareer: { correct: 0, total: 0 },
    disciplines: { correct: 0, total: 0 },
  };
  let truePositive = 0; let unsupportedClaim = 0; let valueMismatch = 0; let falseNegative = 0;
  let inputTokens = 0; let outputTokens = 0; let actualCostCents = 0; let costCount = 0;
  const validResults = results.filter((result) => result.valid);
  for (const result of validResults) {
    for (const verdict of result.fields) {
      const counts = fieldCounts[verdict.field];
      if (verdict.verdict === 'true-positive') { counts.truePositive += 1; truePositive += 1; }
      else if (verdict.verdict === 'unsupported-claim') { counts.unsupportedClaim += 1; unsupportedClaim += 1; }
      else if (verdict.verdict === 'value-mismatch') { counts.valueMismatch += 1; valueMismatch += 1; }
      else if (verdict.verdict === 'false-negative') { counts.falseNegative += 1; falseNegative += 1; }
      else { counts.trueNegative += 1; }
    }
    if (result.classification) {
      classification.technical.total += 1; if (result.classification.technical) classification.technical.correct += 1;
      classification.earlyCareer.total += 1; if (result.classification.earlyCareer) classification.earlyCareer.correct += 1;
      classification.disciplines.total += 1; if (result.classification.disciplines) classification.disciplines.correct += 1;
    }
    if (result.cost) {
      inputTokens += result.cost.inputTokens; outputTokens += result.cost.outputTokens;
      actualCostCents += result.cost.actualCostCents; costCount += 1;
    }
  }
  const presentDenominator = truePositive + unsupportedClaim + valueMismatch;
  const recallDenominator = truePositive + valueMismatch + falseNegative;
  return {
    cases: results.length,
    validCases: validResults.length,
    invalidCases: results.length - validResults.length,
    classification,
    fieldCounts,
    precision: presentDenominator > 0 ? truePositive / presentDenominator : null,
    recall: recallDenominator > 0 ? truePositive / recallDenominator : null,
    unsupportedClaimRate: presentDenominator > 0 ? unsupportedClaim / presentDenominator : null,
    valueMismatchRate: presentDenominator > 0 ? valueMismatch / presentDenominator : null,
    cost: { inputTokens, outputTokens, actualCostCents, avgCostCentsPerCase: costCount > 0 ? actualCostCents / costCount : null },
  };
}

export function parseShadowEvalCases(raw: unknown): ShadowEvalCase[] {
  if (!isRecord(raw) || raw.version !== 1) throw new Error('Dataset must be an object with version 1');
  const rawCases = raw.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) throw new Error('Dataset cases must be a non-empty array');
  const ids = new Set<string>();
  return rawCases.map((entry, index) => {
    const where = (rule: string) => `case ${index}${isRecord(entry) && typeof entry.id === 'string' ? ` (${entry.id})` : ''}: ${rule}`;
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) throw new Error(where('id must be a non-empty string'));
    if (ids.has(entry.id)) throw new Error(where('id is duplicated'));
    ids.add(entry.id);
    if (typeof entry.title !== 'string' || entry.title.length === 0) throw new Error(where('title must be a non-empty string'));
    if (typeof entry.description !== 'string' || entry.description.length === 0) throw new Error(where('description must be a non-empty string'));
    if (!isRecord(entry.expected)) throw new Error(where('expected must be an object'));
    const expected = entry.expected;
    if (!isRecord(expected.classification)) throw new Error(where('expected.classification must be an object'));
    const classification = expected.classification;
    const technicalValue = classification.technical;
    const earlyCareerValue = classification.earlyCareer;
    if (technicalValue !== 'yes' && technicalValue !== 'no' && technicalValue !== 'unknown') {
      throw new Error(where('technical must be yes, no, or unknown'));
    }
    if (earlyCareerValue !== 'yes' && earlyCareerValue !== 'no' && earlyCareerValue !== 'unknown') {
      throw new Error(where('earlyCareer must be yes, no, or unknown'));
    }
    const technical = technicalValue as ClassificationLabel;
    const earlyCareer = earlyCareerValue as ClassificationLabel;
    if (!Array.isArray(classification.disciplines)) throw new Error(where('disciplines must be an array'));
    const disciplines: string[] = [];
    for (const item of classification.disciplines) {
      if (typeof item !== 'string' || item.trim().length === 0) throw new Error(where('disciplines entries must be non-empty strings'));
      disciplines.push(item.trim());
    }
    if (!isRecord(expected.fields)) throw new Error(where('expected.fields must be an object'));
    for (const key of Object.keys(expected.fields)) {
      if (!(shadowEvalFields as readonly string[]).includes(key)) throw new Error(where(`unknown field key ${key}`));
    }
    const fields: ShadowEvalExpected['fields'] = {};
    for (const field of shadowEvalFields) {
      if (!(field in expected.fields)) continue;
      const label = expected.fields[field];
      if (!isRecord(label) || typeof label.status !== 'string') throw new Error(where(`${field} label must have a status`));
      const statusValue = label.status;
      if (statusValue !== 'present' && statusValue !== 'not-stated' && statusValue !== 'conflicting' && statusValue !== 'incomplete') {
        throw new Error(where(`${field} status is invalid`));
      }
      const status = statusValue as ShadowStatus;
      const hasValue = 'value' in label;
      if (status === 'present' && !hasValue) throw new Error(where(`${field} is present without a value`));
      if (status !== 'present' && hasValue) throw new Error(where(`${field} has a value while ${status}`));
      fields[field] = { status, ...(hasValue ? { value: label.value } : {}) };
    }
    return { id: entry.id, title: entry.title, description: entry.description,
      expected: { classification: { technical, earlyCareer, disciplines }, fields } };
  });
}

export function parseShadowRecordedRuns(raw: unknown): ShadowRecordedFixture {
  if (!isRecord(raw) || raw.version !== 1) throw new Error('Recorded fixture must be an object with version 1');
  if (typeof raw.recordedAt !== 'string' || typeof raw.modelId !== 'string' || raw.modelId.length === 0) {
    throw new Error('Recorded fixture recordedAt and modelId are required');
  }
  const rawCases = raw.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) throw new Error('Recorded fixture cases must be a non-empty array');
  const cases = rawCases.map((entry, index) => {
    const where = (rule: string) => `recorded case ${index}${isRecord(entry) && typeof entry.id === 'string' ? ` (${entry.id})` : ''}: ${rule}`;
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) throw new Error(where('id must be a non-empty string'));
    if (typeof entry.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.contentHash)) throw new Error(where('contentHash must be a 64-char hex string'));
    if (!isRecord(entry.result)) throw new Error(where('result must be an object'));
    const result = entry.result;
    for (const key of ['inputTokens', 'outputTokens', 'actualCostCents'] as const) {
      const value = result[key];
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(where(`${key} must be a non-negative integer`));
    }
    return { id: entry.id, contentHash: entry.contentHash,
      result: { response: result.response, inputTokens: result.inputTokens as number, outputTokens: result.outputTokens as number,
        actualCostCents: result.actualCostCents as number } };
  });
  return { version: 1, recordedAt: raw.recordedAt, modelId: raw.modelId, cases };
}
