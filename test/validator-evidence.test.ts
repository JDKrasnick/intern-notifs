import { describe, expect, it } from 'vitest';
import { normalizeExactPostingDescription, validateShadowExtraction } from '../src/shadow-extraction.js';
import type { ShadowExtraction } from '../src/shadow-extraction.js';

function extraction(locationsEvidence: string[]): ShadowExtraction {
  return {
    classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software engineering'] },
    fields: {
      compensation: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      locations: { value: ['Washington DC'], status: 'present', evidence: locationsEvidence, qualifiers: [] },
      workMode: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    },
  };
}

describe('validateShadowExtraction evidence membership', () => {
  const description = 'Base location is Washington, DC: on-site five days a week. We offer housing assistance for eligible interns.';
  const input = normalizeExactPostingDescription('Software Engineer Intern', description);
  it('accepts a byte-exact passage', () => {
    const result = validateShadowExtraction(extraction(['Base location is Washington, DC: on-site five days a week.']), input);
    expect(result.accepted?.fields.locations.status).toBe('present');
  });
  it('accepts a passage differing only in whitespace, case, or punctuation', () => {
    const result = validateShadowExtraction(extraction(['Base location is Washington DC on-site five days a week']), input);
    expect(result.accepted?.fields.locations.status, JSON.stringify(result.failures)).toBe('present');
  });
  it('accepts when a present field quotes with normalized casing', () => {
    const result = validateShadowExtraction(extraction(['we offer housing assistance for eligible interns']), input);
    expect(result.accepted?.fields.locations.status, JSON.stringify(result.failures)).toBe('present');
  });
  it('rejects a paraphrase whose words are not contiguous in the source', () => {
    const result = validateShadowExtraction(extraction(['Location is the capital with full on-site work']), input);
    expect(result.accepted).toBeUndefined();
    expect(result.failures.some((failure) => failure.includes('supporting passage absent'))).toBe(true);
  });
  it('rejects reordered source words', () => {
    const result = validateShadowExtraction(extraction(['days week five a on-site DC Washington is location Base']), input);
    expect(result.accepted).toBeUndefined();
  });
  it('rejects a passage over the length bound even when word-contiguous', () => {
    const long = `${description} ${description} ${description}`;
    const longInput = normalizeExactPostingDescription('Software Engineer Intern', `${long} and even more detail beyond the limit.`);
    const quote = 'and even more detail beyond the limit';
    const padded = 'x '.repeat(2_100) + quote;
    const result = validateShadowExtraction(extraction([padded]), longInput);
    expect(result.accepted).toBeUndefined();
  });
});
