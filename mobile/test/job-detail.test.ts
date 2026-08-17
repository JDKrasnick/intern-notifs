import { describe, expect, it } from 'vitest';
import {
  destinationFromNotification,
  destinationFromUrl,
  freshnessLabel,
  isNewJob,
  isDuplicateJobOpen,
  jobOpenDisposition,
  jobDetailPresentation,
  jobDeepLink,
  routeFailureState,
  sourcePresentation,
  validatedOfficialUrl,
} from '../src/job-detail.js';

describe('mobile job routes', () => {
  it('parses compatible notification payloads and encoded app URLs', () => {
    expect(destinationFromNotification({ jobId: 'legacy/job' })).toEqual({ kind: 'job', jobId: 'legacy/job', reasons: [], exclusionsApplied: false });
    expect(destinationFromNotification({ applicationId: 'application-1', destination: 'saved' })).toEqual({ kind: 'saved' });
    const url = jobDeepLink('role/with spaces');
    expect(url).toBe('internnotifs://jobs/role%2Fwith%20spaces');
    expect(destinationFromUrl(url)).toEqual({ kind: 'job', jobId: 'role/with spaces', reasons: [], exclusionsApplied: false });
    expect(destinationFromUrl('https://example.com/jobs/role')).toBeUndefined();
  });

  it('keeps valid structured match reasons and ignores malformed values', () => {
    expect(destinationFromNotification({
      jobId: 'role-1',
      matchedFilters: { reasons: [{ kind: 'category', label: 'AI/ML' }, { kind: 'unknown', label: 'Nope' }], exclusionsApplied: true },
    })).toEqual({ kind: 'job', jobId: 'role-1', reasons: [{ kind: 'category', label: 'AI/ML' }], exclusionsApplied: true });
  });

  it('suppresses duplicate initial events for the active role', () => {
    expect(isDuplicateJobOpen('role-1', 'role-1')).toBe(true);
    expect(isDuplicateJobOpen('role-1', 'role-2')).toBe(false);
    expect(isDuplicateJobOpen('role-1', 'role-1', true)).toBe(false);
  });

  it('serializes role replacement through native sheet dismissal', () => {
    expect(jobOpenDisposition(undefined, 'role-1')).toBe('open');
    expect(jobOpenDisposition('role-1', 'role-1')).toBe('ignore');
    expect(jobOpenDisposition('role-1', 'role-2')).toBe('replace');
    expect(jobOpenDisposition(undefined, 'role-2', true)).toBe('replace');
  });

  it('keeps one sheet mounted while a routed role changes from loading to detail', () => {
    expect(jobDetailPresentation(false, 'idle')).toEqual({ visible: false, content: 'hidden' });
    expect(jobDetailPresentation(false, 'loading')).toEqual({ visible: true, content: 'route' });
    expect(jobDetailPresentation(true, 'idle')).toEqual({ visible: true, content: 'job' });
    expect(jobDetailPresentation(false, 'missing')).toEqual({ visible: true, content: 'route' });
    expect(jobDetailPresentation(false, 'error')).toEqual({ visible: true, content: 'route' });
  });
});

describe('mobile job trust and freshness', () => {
  it('distinguishes official, community, and corroborated sources', () => {
    expect(sourcePresentation([{ sourceId: 'greenhouse-acme' }])).toEqual({ primary: 'Official employer source · Greenhouse', corroboration: undefined });
    expect(sourcePresentation([{ sourceId: 'lever-acme' }, { sourceId: 'community-list', sourceUrl: 'https://raw.githubusercontent.com/example/jobs/main/README.md' }])).toEqual({ primary: 'Official employer source · Lever', corroboration: 'Also corroborated by a community listing' });
    expect(sourcePresentation([{ sourceId: 'community-list', sourceUrl: 'https://github.com/example/jobs' }])).toEqual({ primary: 'Community listing', corroboration: undefined });
    expect(sourcePresentation([{ sourceId: 'ashby-acme' }, { sourceId: 'greenhouse-acme' }]).primary).toBe('Official employer source · Ashby + Greenhouse');
  });

  it('uses relative confirmation times for recent checks and dates for older checks', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(freshnessLabel('2026-08-10T08:00:00Z', now)).toBe('Confirmed today');
    expect(freshnessLabel('2026-08-08T08:00:00Z', now)).toBe('Confirmed 2 days ago');
    expect(freshnessLabel('2026-08-01T08:00:00Z', now)).toMatch(/^Confirmed Aug 1, 2026$/);
  });

  it('uses the previous visit for signed-in users and 72 hours for guests', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(isNewJob('2026-08-09T12:00:00Z', { signedIn: true, previousCatalogOpenedAt: '2026-08-09T00:00:00Z', now })).toBe(true);
    expect(isNewJob('2026-08-08T12:00:00Z', { signedIn: true, previousCatalogOpenedAt: '2026-08-09T00:00:00Z', now })).toBe(false);
    expect(isNewJob('2026-08-07T13:00:00Z', { signedIn: false, now })).toBe(true);
    expect(isNewJob('2026-08-07T11:59:59Z', { signedIn: false, now })).toBe(false);
  });

  it('only exposes closed official links after validation', () => {
    expect(validatedOfficialUrl({ applyUrl: 'https://careers.example.com/role', applicationUrlValidatedAt: '2026-08-10T00:00:00Z' })).toBe('https://careers.example.com/role');
    expect(validatedOfficialUrl({ applyUrl: 'https://careers.example.com/role' })).toBeUndefined();
    expect(validatedOfficialUrl({ applyUrl: 'https://careers.example.com/role', applicationUrlValidatedAt: '2026-08-10T00:00:00Z', invalidApplicationUrl: 'https://careers.example.com/role' })).toBeUndefined();
  });

  it('separates missing roles from retryable route failures', () => {
    expect(routeFailureState(new Error('Job not found'))).toBe('missing');
    expect(routeFailureState(new Error('The request timed out'))).toBe('error');
  });
});
