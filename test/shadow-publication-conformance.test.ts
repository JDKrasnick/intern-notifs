import { describe, expect, it } from 'vitest';
import { deterministicBaselineFields, fieldBaselineConformance } from '../src/shadow-publication.js';

describe('fieldBaselineConformance', () => {
  it('confirms when deterministic evidence and the LLM both claim present', () => {
    expect(fieldBaselineConformance('locations', 'correct-present', 'present'))
      .toEqual({ field: 'locations', baseline: 'present', advisory: 'deterministic-confirm' });
  });
  it('flags an LLM present claim where deterministic stayed silent', () => {
    expect(fieldBaselineConformance('workMode', 'correct-present', 'not-stated'))
      .toEqual({ field: 'workMode', baseline: 'not-stated', advisory: 'deterministic-conflict' });
    expect(fieldBaselineConformance('compensation', 'false-positive', 'incomplete'))
      .toEqual({ field: 'compensation', baseline: 'incomplete', advisory: 'deterministic-conflict' });
  });
  it('flags a correct-absent review where deterministic evidence existed', () => {
    expect(fieldBaselineConformance('housing', 'correct-absent', 'present'))
      .toEqual({ field: 'housing', baseline: 'present', advisory: 'deterministic-conflict' });
  });
  it('treats agreed absence as consistent', () => {
    expect(fieldBaselineConformance('timing', 'correct-absent', 'not-stated'))
      .toEqual({ field: 'timing', baseline: 'not-stated', advisory: 'deterministic-consistent' });
    expect(fieldBaselineConformance('education', 'false-negative', 'not-stated'))
      .toEqual({ field: 'education', baseline: 'not-stated', advisory: 'deterministic-consistent' });
  });
  it('marks fields without a deterministic slot (eligibility) as llm-only', () => {
    expect(fieldBaselineConformance('eligibility', 'correct-present', 'unavailable'))
      .toEqual({ field: 'eligibility', baseline: 'unavailable', advisory: 'llm-only' });
    expect(deterministicBaselineFields).not.toContain('eligibility');
  });
  it('distinguishes a missing deterministic baseline from an LLM-only field', () => {
    expect(fieldBaselineConformance('compensation', 'correct-absent', 'unavailable'))
      .toEqual({ field: 'compensation', baseline: 'unavailable', advisory: 'baseline-unavailable' });
  });
});
