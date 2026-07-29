import { describe, expect, it } from 'vitest';
import {
  detectGreenhouseQuickApply,
  isGreenhouseApplicationUrl,
  planGreenhouseFields,
  runGreenhouseHeadedAssistant,
  type GreenhousePage,
} from '../src/greenhouse-headed.js';

const values = {
  contact: {
    name: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    email: 'jordan@example.com',
    phone: '+1 212 555 0100',
  },
};

const quickApply = { id: 'quick-apply', text: 'Quick Apply with MyGreenhouse', role: 'button' as const, visible: true, enabled: true };
const page = (overrides: Partial<GreenhousePage> = {}): GreenhousePage => ({
  url: 'https://job-boards.greenhouse.io/acme/jobs/123',
  controls: [quickApply],
  fields: [],
  ...overrides,
});

describe('Greenhouse headed assistant', () => {
  it('accepts only reviewed Greenhouse application hosts', () => {
    expect(isGreenhouseApplicationUrl('https://boards.greenhouse.io/acme/jobs/123')).toBe(true);
    expect(isGreenhouseApplicationUrl('https://job-boards.greenhouse.io/acme/jobs/123')).toBe(true);
    expect(isGreenhouseApplicationUrl('https://job-boards.eu.greenhouse.io/acme/jobs/123')).toBe(true);
    expect(isGreenhouseApplicationUrl('https://greenhouse.io.evil.example/jobs/123')).toBe(false);
    expect(isGreenhouseApplicationUrl('https://example.com/?next=boards.greenhouse.io')).toBe(false);
  });

  it('detects exactly one visible, enabled Quick Apply control and supplies a scroll target', () => {
    expect(detectGreenhouseQuickApply(page())).toEqual({ outcome: 'ready', controlId: 'quick-apply', scrollTargetId: 'quick-apply' });
    expect(detectGreenhouseQuickApply(page({ controls: [{ ...quickApply, text: undefined, ariaLabel: '  AUTOFILL with Greenhouse  ' }] }))).toMatchObject({ outcome: 'ready' });
  });

  it('fails closed for an unreviewed host, verification challenge, generic apply link, hidden control, or duplicate Quick Apply controls', () => {
    expect(detectGreenhouseQuickApply(page({ url: 'https://apply.example.com/123' }))).toEqual({ outcome: 'manual', reason: 'not-greenhouse' });
    expect(detectGreenhouseQuickApply(page({ challenge: 'captcha' }))).toEqual({ outcome: 'manual', reason: 'challenge' });
    expect(detectGreenhouseQuickApply(page({ controls: [{ ...quickApply, text: 'Apply now' }] }))).toEqual({ outcome: 'manual', reason: 'not-found' });
    expect(detectGreenhouseQuickApply(page({ controls: [{ ...quickApply, visible: false }] }))).toEqual({ outcome: 'manual', reason: 'not-found' });
    expect(detectGreenhouseQuickApply(page({ controls: [quickApply, { ...quickApply, id: 'second' }] }))).toEqual({ outcome: 'manual', reason: 'ambiguous' });
  });

  it('fills only exact simple profile fields and leaves documents, sponsorship, voluntary fields, and unknowns untouched', () => {
    const fields = planGreenhouseFields(page({ fields: [
      { id: 'first', label: 'First name', autocomplete: 'given-name', type: 'text', required: true, visible: true, enabled: true },
      { id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'resume', label: 'Resume/CV', type: 'file', required: true, visible: true, enabled: true },
      { id: 'sponsor', label: 'Will you need sponsorship?', type: 'radio', required: true, visible: true, enabled: true },
      { id: 'gender', label: 'Voluntary gender self identification', type: 'radio', required: false, visible: true, enabled: true },
      { id: 'unknown', label: 'Why this company?', type: 'text', required: true, visible: true, enabled: true },
    ] }), values);
    expect(fields).toMatchObject([
      { key: 'first_name', resolved: true, treatment: 'auto-fill', valueRef: { key: 'contact.firstName' } },
      { key: 'email', resolved: true, treatment: 'auto-fill', valueRef: { key: 'contact.email' } },
      { key: 'resume', resolved: false, treatment: 'review-required' },
      { key: 'work_authorization', resolved: false, treatment: 'review-required', classification: 'sensitive' },
      { key: 'voluntary_self_identification', resolved: false, treatment: 'never-fill', classification: 'voluntary-self-identification' },
      { key: 'unknown', resolved: false, treatment: 'review-required' },
    ]);
    expect(fields.flatMap((field) => Object.keys(field))).not.toContain('value');
  });

  it('does not guess name parts or fill duplicated, hidden, disabled, or mismatched controls', () => {
    const onlyFullName = { contact: { ...values.contact, firstName: undefined, lastName: undefined } };
    const fields = planGreenhouseFields(page({ fields: [
      { id: 'first', label: 'First name', autocomplete: 'given-name', type: 'text', required: true, visible: true, enabled: true },
      { id: 'email-1', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'email-2', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'hidden-phone', label: 'Phone', autocomplete: 'tel', type: 'tel', required: false, visible: false, enabled: true },
      { id: 'disabled-phone', label: 'Phone', autocomplete: 'tel', type: 'tel', required: false, visible: true, enabled: false },
      { id: 'email-as-text', label: 'Email', autocomplete: '', type: 'text', required: true, visible: true, enabled: true },
    ] }), onlyFullName);
    expect(fields).toMatchObject([
      { key: 'first_name', resolved: false, treatment: 'auto-fill' },
      { key: 'email', resolved: false, treatment: 'auto-fill' },
      { key: 'email', resolved: false, treatment: 'auto-fill' },
      { key: 'email', resolved: false, treatment: 'auto-fill' },
    ]);
  });

  it('matches the live Greenhouse email shape: a text input with email autocomplete', () => {
    const fields = planGreenhouseFields(page({ fields: [
      { id: 'email', label: 'Email', autocomplete: 'email', type: 'text', required: true, visible: true, enabled: true },
    ] }), values);
    expect(fields[0]).toMatchObject({ key: 'email', resolved: true, treatment: 'auto-fill', valueRef: { key: 'contact.email' } });
  });

  it('scrolls to the reviewed action, clicks it only after approval, and never clicks final submission', () => {
    const calls: string[] = [];
    const browser = {
      scrollIntoView: (id: string) => calls.push(`scroll:${id}`),
      click: (id: string) => calls.push(`click:${id}`),
      fill: (id: string, value: string) => calls.push(`fill:${id}:${value}`),
    };
    const withEmail = page({ fields: [{ id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true }] });
    runGreenhouseHeadedAssistant(browser, withEmail, values, false);
    expect(calls).toEqual(['scroll:quick-apply', 'fill:email:jordan@example.com']);
    calls.length = 0;
    runGreenhouseHeadedAssistant(browser, withEmail, values, true);
    expect(calls).toEqual(['scroll:quick-apply', 'click:quick-apply', 'fill:email:jordan@example.com']);
    expect(calls).not.toContain('click:submit');
  });
});
