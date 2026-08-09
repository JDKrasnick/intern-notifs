import { describe, expect, it } from 'vitest';
import { shouldShowBrowserCompanion } from '../src/companion-surface.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';

const email = { id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true };
const quickApply = { id: 'quick', text: 'Quick Apply with MyGreenhouse', role: 'button' as const, visible: true, enabled: true };

describe('browser companion surface gate', () => {
  it('appears on a reviewed Greenhouse Quick Apply control or contact form', () => {
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [quickApply], fields: [] })).toBe(true);
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [], fields: [email] })).toBe(true);
  });

  it('appears on direct supported ATS forms, including forms with no safe contact fields', () => {
    expect(shouldShowBrowserCompanion({ url: 'https://jobs.lever.co/acme/1/apply', controls: [], fields: [email] })).toBe(true);
    expect(shouldShowBrowserCompanion({ url: 'https://jobs.lever.co/acme/1/apply', controls: [], fields: [] })).toBe(true);
    const published = [{ ...reviewedAshbySources[0], status: 'published' as const }];
    expect(shouldShowBrowserCompanion({
      url: 'https://jobs.ashbyhq.com/etched/123e4567-e89b-12d3-a456-426614174000/application', controls: [], fields: [],
    }, published)).toBe(true);
  });

  it('is hidden on a job listing, generic page, or unreviewed destination, but stays visible for a handoff', () => {
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [{ ...quickApply, text: 'Apply' }], fields: [] })).toBe(false);
    expect(shouldShowBrowserCompanion({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', controls: [quickApply], fields: [email], challenge: 'captcha' })).toBe(true);
    expect(shouldShowBrowserCompanion({ url: 'https://apply.example.com/1', controls: [quickApply], fields: [email] })).toBe(false);
  });
});
