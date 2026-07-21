import { describe, expect, it } from 'vitest';
import { nextFocusableApplicationField } from '../src/headed-focus.js';

describe('headed application focus advance', () => {
  it('moves to the next visible, enabled text-like field after completion', () => {
    expect(nextFocusableApplicationField([
      { id: 'first', completed: true, visible: true, enabled: true, focusable: true },
      { id: 'hidden', completed: false, visible: false, enabled: true, focusable: true },
      { id: 'email', completed: false, visible: true, enabled: true, focusable: true },
    ], 'first')).toEqual({ id: 'email', completed: false, visible: true, enabled: true, focusable: true });
  });

  it('does not jump before completion or onto disabled, radio, file, or submit controls', () => {
    const fields = [
      { id: 'first', completed: false, visible: true, enabled: true, focusable: true },
      { id: 'sponsorship', completed: false, visible: true, enabled: true, focusable: false },
      { id: 'resume', completed: false, visible: true, enabled: true, focusable: false },
      { id: 'submit', completed: false, visible: true, enabled: true, focusable: false },
      { id: 'email', completed: false, visible: true, enabled: false, focusable: true },
    ];
    expect(nextFocusableApplicationField(fields, 'first')).toBeUndefined();
    expect(nextFocusableApplicationField([{ ...fields[0], completed: true }, ...fields.slice(1)], 'first')).toBeUndefined();
  });

  it('does not pull focus backward to a field that has already been filled', () => {
    expect(nextFocusableApplicationField([
      { id: 'first', completed: true, visible: true, enabled: true, focusable: true },
      { id: 'email', completed: true, visible: true, enabled: true, focusable: true },
      { id: 'phone', completed: false, visible: true, enabled: true, focusable: true },
    ], 'first')?.id).toBe('phone');
  });
});
