import { describe, expect, it } from 'vitest';
import {
  detectAshbyApplication,
  isAshbyApplicationUrl,
  publishedAshbyBoardKeys,
  runAshbyHeadedAssistant,
} from '../src/ashby-headed.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';

const published = [{ ...reviewedAshbySources[0], status: 'published' as const }];
const values = { contact: { name: 'Jordan Lee', firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com', phone: '+1 212 555 0100' } };
const page = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://jobs.ashbyhq.com/etched/123e4567-e89b-12d3-a456-426614174000/application',
  controls: [],
  fields: [{ id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true }],
  ...overrides,
});

describe('Ashby headed assistant', () => {
  it('derives its exact case-sensitive allowlist only from published reviewed boards', () => {
    expect(publishedAshbyBoardKeys()).toEqual(new Set());
    expect(publishedAshbyBoardKeys(published)).toEqual(new Set(['etched']));
    expect(isAshbyApplicationUrl(page().url)).toBe(false);
    expect(isAshbyApplicationUrl(page().url, published)).toBe(true);
    expect(isAshbyApplicationUrl(page().url.replace('/etched/', '/Etched/'), published)).toBe(false);
  });

  it('accepts only direct approved Ashby application routes', () => {
    const valid = page().url;
    expect(isAshbyApplicationUrl(valid, published)).toBe(true);
    expect(isAshbyApplicationUrl(valid.replace('/application', ''), published)).toBe(false);
    expect(isAshbyApplicationUrl(valid.replace('/application', '/application/next'), published)).toBe(false);
    expect(isAshbyApplicationUrl(valid.replace('123e4567-e89b-12d3-a456-426614174000', 'not-an-id'), published)).toBe(false);
    expect(isAshbyApplicationUrl(valid.replace('jobs.ashbyhq.com', 'jobs.ashbyhq.com.evil.example'), published)).toBe(false);
    expect(isAshbyApplicationUrl(valid.replace('jobs.ashbyhq.com', 'apply.example.com'), published)).toBe(false);
    expect(isAshbyApplicationUrl(valid.replace('https://', 'https://student:secret@'), published)).toBe(false);
    expect(isAshbyApplicationUrl(valid.replace('jobs.ashbyhq.com', 'jobs.ashbyhq.com:444'), published)).toBe(false);
  });

  it('reports an unapproved board, route mismatch, or challenge without filling', () => {
    expect(detectAshbyApplication(page(), [])).toEqual({ outcome: 'manual', reason: 'unapproved-route' });
    expect(detectAshbyApplication(page({ url: 'https://jobs.ashbyhq.com/etched' }), published)).toEqual({ outcome: 'manual', reason: 'host-path-mismatch' });
    expect(detectAshbyApplication(page({ challenge: 'captcha' }), published)).toEqual({ outcome: 'manual', reason: 'challenge' });

    const calls: string[] = [];
    runAshbyHeadedAssistant({ scrollIntoView: (id) => calls.push(`scroll:${id}`), click: () => calls.push('click'), fill: () => calls.push('fill') }, page(), values, []);
    expect(calls).toEqual([]);
  });

  it('uses only the shared exact-contact field plan and never clicks', () => {
    const calls: string[] = [];
    const result = runAshbyHeadedAssistant({
      scrollIntoView: (id) => calls.push(`scroll:${id}`),
      click: () => calls.push('click'),
      fill: (id, value) => calls.push(`fill:${id}:${value}`),
    }, page({ fields: [
      { id: 'email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'duplicate-email', label: 'Email', autocomplete: 'email', type: 'email', required: true, visible: true, enabled: true },
      { id: 'resume', label: 'Resume', type: 'file', required: true, visible: true, enabled: true },
      { id: 'sponsor', label: 'Will you need sponsorship?', type: 'radio', required: true, visible: true, enabled: true },
      { id: 'gender', label: 'Voluntary gender self identification', type: 'radio', required: false, visible: true, enabled: true },
      { id: 'why', label: 'Why this company?', type: 'text', required: true, visible: true, enabled: true },
    ] }), values, published);
    expect(result.fields.flatMap((field) => Object.keys(field))).not.toContain('value');
    expect(result.fields).toMatchObject([
      { key: 'email', treatment: 'auto-fill', resolved: false },
      { key: 'email', treatment: 'auto-fill', resolved: false },
      { key: 'resume', treatment: 'review-required', resolved: false },
      { key: 'work_authorization', treatment: 'review-required', resolved: false },
      { key: 'voluntary_self_identification', treatment: 'never-fill', resolved: false },
      { key: 'why', treatment: 'review-required', resolved: false },
    ]);
    expect(calls).toEqual(['scroll:email']);
  });
});
