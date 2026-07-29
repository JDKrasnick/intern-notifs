import { describe, expect, it } from 'vitest';
import { shouldShowBrowserCompanion } from '../src/companion-surface.js';

const email = { id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true };
const quickApply = { id: 'quick', text: 'Quick Apply with MyGreenhouse', role: 'button' as const, visible: true, enabled: true };

describe('browser companion surface gate', () => {
  it('appears on a reviewed Greenhouse Quick Apply control or contact form', () => {
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [quickApply], fields: [] })).toBe(true);
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [], fields: [email] })).toBe(true);
  });

  it('appears on a direct Lever form only when a reviewed contact field exists', () => {
    expect(shouldShowBrowserCompanion({ url: 'https://jobs.lever.co/acme/1/apply', controls: [], fields: [email] })).toBe(true);
    expect(shouldShowBrowserCompanion({ url: 'https://jobs.lever.co/acme/1/apply', controls: [], fields: [] })).toBe(false);
  });

  it('is hidden on a job listing, generic page, challenge page, or unreviewed destination', () => {
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [{ ...quickApply, text: 'Apply' }], fields: [] })).toBe(false);
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [quickApply], fields: [email], challenge: 'captcha' })).toBe(false);
    expect(shouldShowBrowserCompanion({ url: 'https://apply.example.com/1', controls: [quickApply], fields: [email] })).toBe(false);
  });
});
