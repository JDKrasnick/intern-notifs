import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship } from '../src/types.js';

const job: Internship = { jobId: 'job-1', company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://apply.example.test/role', normalizedUrl: 'https://apply.example.test/role', fingerprint: 'acme', compensation: { raw: '' }, sourceReferences: [], open: true, firstSeenAt: '2026-07-19T00:00:00.000Z', lastSeenAt: '2026-07-19T00:00:00.000Z', notification: { smsPending: false, digestPending: false } };
const event = (userId: string | undefined, method: string, rawPath: string, body?: unknown, queryStringParameters?: Record<string, string>) => ({ rawPath, queryStringParameters, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) } });
const hasUndefined = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.some(hasUndefined)) ||
  (value !== null && typeof value === 'object' && Object.values(value).some(hasUndefined));

describe('public API ownership boundary', () => {
  it('makes the feed public while keeping applications private to their Cognito subject', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job); await jobs.putInternship({ ...job, jobId: 'closed-job', open: false }); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs'))).body).jobs).toHaveLength(1);
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs', undefined, { status: 'closed' }))).body).jobs).toMatchObject([{ jobId: 'closed-job', open: false }]);
    expect((await handler(event(undefined, 'GET', '/me/applications'))).statusCode).toBe(401);
    const created = await handler(event('user-a', 'POST', '/me/applications', { jobId: 'job-1', notes: 'Tailor résumé' }));
    expect(created.statusCode).toBe(201);
    expect(JSON.parse((await handler(event('user-b', 'GET', '/me/applications'))).body)).toEqual({ applications: [] });
    const applicationId = JSON.parse(created.body).applicationId as string;
    expect((await handler(event('user-b', 'PATCH', `/me/applications/${applicationId}`, { status: 'offer' }))).statusCode).toBe(404);
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications'))).body).applications[0]).toMatchObject({ jobId: 'job-1', applyMode: 'official-form' });
  });
  it('persists per-user alert templates without resetting existing alert preferences', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    const first = await handler(event('user-a', 'PUT', '/me/preferences', { filter: { includeCategories: ['swe'], includeEmployerCategories: ['faang', 'startup'] }, alertsEnabled: true, onboardingComplete: true, push: { titleTemplate: '{company}: {title}', descriptionTemplate: '{location}\n{url}' } }));
    expect(JSON.parse(first.body)).toMatchObject({ alertsEnabled: true, push: { titleTemplate: '{company}: {title}' } });
    const second = await handler(event('user-a', 'PUT', '/me/preferences', { push: { titleTemplate: '{shortTitle} — {company}' } }));
    expect(JSON.parse(second.body)).toMatchObject({ filter: { includeCategories: ['swe'], includeEmployerCategories: ['faang', 'startup'] }, alertsEnabled: true, onboardingComplete: true, push: { titleTemplate: '{shortTitle} — {company}' } });
  });
  it('validates and preserves delivery settings for alert controls', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    const saved = await handler(event('user-a', 'PUT', '/me/preferences', {
      alertSettings: {
        delivery: 'daily-digest',
        quietHours: { start: '22:00', end: '08:00', timezone: 'America/New_York' },
        applicationReminders: true,
        followUpDays: 5
      }
    }));
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ alertSettings: { delivery: 'daily-digest', quietHours: { start: '22:00', end: '08:00' }, applicationReminders: true, followUpDays: 5 } });
    const invalid = await handler(event('user-a', 'PUT', '/me/preferences', { alertSettings: { quietHours: { start: 'after dark', end: '08:00', timezone: 'America/New_York' } } }));
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).message).toContain('quietHours');
  });
  it('persists onboarding preferences without undefined optional fields', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    const saved = await handler(event('user-a', 'PUT', '/me/preferences', {
      filter: { includeCategories: ['swe'], includeKeywords: ['backend'] },
      alertsEnabled: false,
      onboardingComplete: true,
      alertSettings: { delivery: 'immediate', applicationReminders: true, followUpDays: 7 }
    }));
    expect(saved.statusCode).toBe(200);
    const preference = await users.getPreferences('user-a');
    expect(preference?.filter).toStrictEqual({ includeCategories: ['swe'], includeKeywords: ['backend'] });
    expect(preference?.alertSettings).toStrictEqual({
      delivery: 'immediate',
      applicationReminders: true,
      followUpDays: 7
    });
    expect(hasUndefined(preference)).toBe(false);
  });
});
