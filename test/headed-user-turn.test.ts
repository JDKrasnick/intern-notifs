import { describe, expect, it } from 'vitest';
import { planGreenhouseFields, type GreenhouseField, type GreenhousePage } from '../src/greenhouse-headed.js';
import { headedFieldCompleted, headedUserTurnReason } from '../src/headed-user-turn.js';

const values = { contact: { name: 'Jordan Lee', email: 'jordan@example.com' } };
const page = (fields: GreenhouseField[], challenge?: GreenhousePage['challenge']): GreenhousePage => ({
  url: 'https://jobs.lever.co/acme/123/apply', controls: [], fields, ...(challenge ? { challenge } : {}),
});

describe('headed Your turn handoff', () => {
  it('treats a selected radio answer as completion for every option in its group', () => {
    expect(headedFieldCompleted({ type: 'radio', checked: false }, true)).toBe(true);
    expect(headedFieldCompleted({ type: 'radio', checked: false }, false)).toBe(false);
    expect(headedFieldCompleted({ type: 'checkbox', checked: false }, true)).toBe(false);
    expect(headedFieldCompleted({ type: 'text', value: '  done  ' })).toBe(true);
  });

  it('blocks verification and does not infer an automatic resume', () => {
    const current = page([{ id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true }], 'captcha');
    expect(headedUserTurnReason(current, planGreenhouseFields(current, values))).toBe('verification');
  });

  it('blocks unresolved required and sensitive fields but not exact contact fields', () => {
    const current = page([
      { id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'resume', label: 'Resume', type: 'file', required: true, visible: true, enabled: true },
      { id: 'gender', label: 'Gender', type: 'radio', required: false, visible: true, enabled: true },
    ]);
    expect(headedUserTurnReason(current, planGreenhouseFields(current, values))).toBe('unresolved-field');

    const completed = page([
      { id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'resume', label: 'Resume', type: 'file', required: true, visible: true, enabled: true, completed: true },
      { id: 'gender', label: 'Gender', type: 'radio', required: false, visible: true, enabled: true },
    ]);
    expect(headedUserTurnReason(completed, planGreenhouseFields(completed, values))).toBe('sensitive-question');

    const selectedRadioGroup = page([
      { id: 'gender-yes', label: 'Gender', type: 'radio', required: false, visible: true, enabled: true, completed: true },
      { id: 'gender-no', label: 'Gender', type: 'radio', required: false, visible: true, enabled: true, completed: true },
    ]);
    expect(headedUserTurnReason(selectedRadioGroup, planGreenhouseFields(selectedRadioGroup, values))).toBeUndefined();
  });
});
