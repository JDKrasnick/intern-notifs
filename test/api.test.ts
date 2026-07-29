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
  it('creates a versioned, no-submit Greenhouse assistance session while keeping unknown and LinkedIn destinations manual', async () => {
    const jobs = new MemoryInternshipStore();
    const greenhouse = { ...job, jobId: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/123', normalizedUrl: 'https://boards.greenhouse.io/acme/jobs/123' };
    const linkedin = { ...job, jobId: 'linkedin', applyUrl: 'https://www.linkedin.com/jobs/view/123', normalizedUrl: 'https://www.linkedin.com/jobs/view/123' };
    await jobs.putInternship(greenhouse); await jobs.putInternship(linkedin);
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs, users, now: () => '2026-07-20T12:00:00.000Z' });

    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs/greenhouse'))).body)).toMatchObject({ assistance: { eligibility: 'headed-supported', primaryAction: 'assist-in-safari' } });
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs/linkedin'))).body)).toMatchObject({ assistance: { eligibility: 'manual-only', reasonCode: 'destination-policy-prohibits-automation' } });

    const application = JSON.parse((await handler(event('student-a', 'POST', '/me/applications', { jobId: 'greenhouse' }))).body) as { applicationId: string; status: string };
    expect(application.status).toBe('saved');
    const queue = JSON.parse((await handler(event('student-a', 'GET', '/me/applications', undefined, { status: 'saved' }))).body) as { applications: Array<{ job: { assistance: { eligibility: string } } }> };
    expect(queue.applications).toMatchObject([{ job: { assistance: { eligibility: 'headed-supported' } } }]);

    const created = await handler(event('student-a', 'POST', `/me/applications/${application.applicationId}/assistance-sessions`, { mode: 'headed' }));
    expect(created.statusCode).toBe(201);
    const handoff = JSON.parse(created.body) as { session: { sessionId: string; userId?: string; version: number }; handoff: { sessionId: string; code: string } };
    expect(handoff.session).toMatchObject({ version: 0 });
    expect(handoff.session.userId).toBeUndefined();

    const exchanged = await handler(event(undefined, 'POST', '/assist/exchange', { sessionId: handoff.handoff.sessionId, code: handoff.handoff.code }));
    expect(exchanged.statusCode).toBe(200);
    const bearer = (JSON.parse(exchanged.body) as { bearer: string }).bearer;
    expect((await handler(event(undefined, 'POST', '/assist/exchange', { sessionId: handoff.handoff.sessionId, code: handoff.handoff.code }))).statusCode).toBe(401);

    const assistedEvent = (payload: unknown) => handler({ ...event(undefined, 'POST', '/assist/session/events', payload), headers: { authorization: `Bearer ${bearer}` } });
    expect((await assistedEvent({ eventId: 'runner-start', expectedVersion: 1, event: { type: 'start' } })).statusCode).toBe(200);
    const field = { key: 'first_name', label: 'First name', required: true, resolved: true, classification: 'standard', confidence: 'exact', valueRef: { source: 'profile', key: 'contact.name' }, maskedPreview: 'S•••' };
    expect((await assistedEvent({ eventId: 'runner-fill', expectedVersion: 2, event: { type: 'fill-completed', fields: [field] } })).statusCode).toBe(200);
    const replay = await assistedEvent({ eventId: 'runner-fill', expectedVersion: 2, event: { type: 'fill-completed', fields: [field] } });
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true, session: { version: 3 } });
    expect((await assistedEvent({ eventId: 'runner-submit', expectedVersion: 3, event: { type: 'submission-confirmed' } })).statusCode).toBe(400);

    const approve = await handler(event('student-a', 'POST', `/me/application-sessions/${handoff.session.sessionId}/events`, { eventId: 'student-review', expectedVersion: 3, event: { type: 'review-approved' } }));
    expect(approve.statusCode).toBe(200);
    const submitted = await handler(event('student-a', 'POST', `/me/application-sessions/${handoff.session.sessionId}/events`, { eventId: 'student-confirmed', expectedVersion: 4, event: { type: 'submission-confirmed' } }));
    expect(submitted.statusCode).toBe(200);
    expect((await users.getApplication('student-a', application.applicationId))?.status).toBe('applied');
  });
});
