import { describe, expect, it } from 'vitest';
import {
  detectLeverApplication,
  isLeverApplicationUrl,
  runLeverHeadedAssistant,
} from '../src/lever-headed.js';

const values = { contact: { name: 'Jordan Lee', firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com', phone: '+1 212 555 0100' } };
const page = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://jobs.lever.co/acme/1234/apply',
  controls: [],
  fields: [{ id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true }],
  ...overrides,
});

describe('Lever headed assistant', () => {
  it('recognizes only direct Lever application paths', () => {
    expect(isLeverApplicationUrl('https://jobs.lever.co/acme/1234/apply')).toBe(true);
    expect(isLeverApplicationUrl('https://jobs.lever.co/acme/1234')).toBe(false);
    expect(isLeverApplicationUrl('https://jobs.lever.co/acme/1234/apply/next')).toBe(false);
    expect(isLeverApplicationUrl('https://jobs.lever.co.evil.example/acme/1234/apply')).toBe(false);
    expect(isLeverApplicationUrl('https://example.com/?apply=https://jobs.lever.co/acme/1234/apply')).toBe(false);
  });

  it('opens directly at the form, scrolls to its first field, and fills only exact contact values', () => {
    const calls: string[] = [];
    const browser = {
      scrollIntoView: (id: string) => calls.push(`scroll:${id}`),
      click: (id: string) => calls.push(`click:${id}`),
      fill: (id: string, value: string) => calls.push(`fill:${id}:${value}`),
    };
    const result = runLeverHeadedAssistant(browser, page(), values);
    expect(result.detection).toEqual({ outcome: 'ready', scrollTargetId: 'email' });
    expect(calls).toEqual(['scroll:email', 'fill:email:jordan@example.com']);
  });

  it('fails closed when a verification challenge is present', () => {
    expect(detectLeverApplication(page({ challenge: 'captcha' }))).toEqual({ outcome: 'manual', reason: 'challenge' });
  });
});
