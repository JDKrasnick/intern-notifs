import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship } from '../src/types.js';

const credentials = { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' };
const job = (id: string, firstSeenAt: string): Internship => ({
  jobId: id, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
  applyUrl: `https://careers.example.test/${id}`, normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id,
  compensation: { raw: '$45/hr', maxHourlyUSD: 45 }, sourceReferences: [], open: true, firstSeenAt, lastSeenAt: firstSeenAt,
  notification: { smsPending: false, digestPending: false },
});

function event(userId: string | undefined, method: string, rawPath: string, body?: unknown, queryStringParameters?: Record<string, string>) {
  return {
    rawPath, queryStringParameters, body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
  };
}
const body = <T>(response: { body: string }) => JSON.parse(response.body) as T;

describe('public catalog and authenticated applicant workflow', () => {
  it('paginates the public feed and returns CORS preflight without requiring an account', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('old', '2026-07-01T00:00:00.000Z'));
    await jobs.putInternship(job('new', '2026-07-02T00:00:00.000Z'));
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });

    const preflight = await handler(event(undefined, 'OPTIONS', '/jobs'));
    expect(preflight).toMatchObject({ statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

    const first = await handler(event(undefined, 'GET', '/jobs', undefined, { limit: '1' }));
    expect(first.statusCode).toBe(200);
    expect(body<{ jobs: Internship[]; cursor?: string }>(first)).toMatchObject({ jobs: [{ jobId: 'new' }] });
    const cursor = body<{ cursor?: string }>(first).cursor;
    expect(cursor).toBeTruthy();
    const second = await handler(event(undefined, 'GET', '/jobs', undefined, { cursor: cursor!, limit: '1' }));
    expect(body<{ jobs: Internship[] }>(second).jobs).toMatchObject([{ jobId: 'old' }]);
    const invalidLimit = await handler(event(undefined, 'GET', '/jobs', undefined, { limit: 'not-a-number' }));
    expect(body<{ jobs: Internship[] }>(invalidLimit).jobs).toHaveLength(2);
  });

  it('returns filtered internships from the previous launch window, then advances the window', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('before', '2026-07-01T00:00:00.000Z'));
    await jobs.putInternship({ ...job('match', '2026-07-19T08:00:00.000Z'), title: 'Machine Learning Intern' });
    await jobs.putInternship({ ...job('excluded', '2026-07-19T08:00:00.000Z'), title: 'Product Design Intern' });
    const users = new MemoryUserStore();
    await users.putPreferences({
      userId: 'student-a', filter: { includeCategories: ['ai-ml'] }, alertsEnabled: false, onboardingComplete: true,
      lastCatalogOpenedAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const handler = createApiHandler({ jobs, users, now: () => '2026-07-19T12:00:00.000Z' });

    const opening = await handler(event('student-a', 'POST', '/me/opening'));
    expect(opening.statusCode).toBe(200);
    expect(body<{ jobs: Internship[]; total: number; previousOpenedAt: string }>(opening)).toMatchObject({
      jobs: [{ jobId: 'match' }], total: 1, previousOpenedAt: '2026-07-18T00:00:00.000Z',
    });
    expect((await users.getPreferences('student-a'))?.lastCatalogOpenedAt).toBeTruthy();
  });

  it('uses the first signed-in launch only to establish a calm baseline', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job('existing', '2026-07-18T00:00:00.000Z'));
    const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users, now: () => '2026-07-19T12:00:00.000Z' });

    const opening = await handler(event('student-a', 'POST', '/me/opening'));
    expect(body<{ jobs: Internship[]; total: number; previousOpenedAt: string | null }>(opening)).toEqual(expect.objectContaining({ jobs: [], total: 0, previousOpenedAt: null }));
    expect((await users.getPreferences('student-a'))?.lastCatalogOpenedAt).toBeTruthy();
  });

  it('runs a private profile, alert, device, and official-form application flow without cross-account access', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job('role-1', '2026-07-02T00:00:00.000Z'));
    const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });

    const preferences = await handler(event('student-a', 'PUT', '/me/preferences', {
      filter: { includeCategories: ['swe'] }, alertsEnabled: true, onboardingComplete: true,
      alertSettings: { delivery: 'daily-digest', applicationReminders: true, followUpDays: 10 },
    }));
    expect(body<{ alertSettings: { delivery: string } }>(preferences).alertSettings.delivery).toBe('daily-digest');
    expect((await handler(event('student-a', 'POST', '/me/devices', { token: 'not-an-expo-token', platform: 'ios' }))).statusCode).toBe(400);
    expect((await handler(event('student-a', 'POST', '/me/devices', { token: 'ExponentPushToken[device-a]', platform: 'ios' }))).statusCode).toBe(201);

    const profile = {
      contact: { name: 'Student A', email: 'student@example.test' }, location: 'Boston, MA', workAuthorization: 'F-1 OPT',
      resumeDocumentId: 'resume-1', education: [{ school: 'Example University', degree: 'BS' }], links: { github: 'https://github.com/student' }, reusableAnswers: { sponsorship: 'Yes' },
    };
    expect((await handler(event('student-a', 'PUT', '/me/profile', profile))).statusCode).toBe(200);
    expect(body<{ userId: string }>(await handler(event('student-b', 'GET', '/me/profile')))).toBeNull();

    const created = await handler(event('student-a', 'POST', '/me/applications', { jobId: 'role-1', notes: 'Tailor résumé' }));
    expect(created.statusCode).toBe(201);
    const application = body<{ applicationId: string; officialApplyUrl?: string; status: string }>(created);
    expect(application).toMatchObject({ status: 'saved', officialApplyUrl: 'https://careers.example.test/role-1' });
    const repeated = await handler(event('student-a', 'POST', '/me/applications', { jobId: 'role-1', status: 'applied' }));
    expect(repeated.statusCode).toBe(200);
    expect(body<{ applicationId: string; status: string }>(repeated)).toMatchObject({ applicationId: application.applicationId, status: 'applied' });
    expect((await handler(event('student-b', 'PATCH', `/me/applications/${application.applicationId}`, { status: 'offer' }))).statusCode).toBe(404);
    expect(body<{ applications: Array<{ status: string }> }>(await handler(event('student-a', 'GET', '/me/applications'))).applications).toMatchObject([{ status: 'applied' }]);
  });

  it('keeps documents private and removes their objects, user records, and Cognito account on deletion', async () => {
    const users = new MemoryUserStore(); const s3 = new S3Client({ region: 'us-east-1', credentials });
    const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1', credentials });
    const s3Send = vi.spyOn(s3, 'send').mockResolvedValue({ $metadata: {} } as never);
    const cognitoSend = vi.spyOn(cognito, 'send').mockResolvedValue({ $metadata: {} } as never);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, documentsBucket: 'private-documents', userPoolId: 'pool-id', s3, cognito });

    const created = await handler(event('student-a', 'POST', '/me/documents', { fileName: 'résumé.pdf', contentType: 'application/pdf' }));
    expect(created.statusCode).toBe(201);
    const document = body<{ document: { documentId: string; objectKey: string }; uploadUrl: string }>(created);
    expect(document.uploadUrl).toContain('private-documents');
    expect(document.document.objectKey).toMatch(/^private\/student-a\//);
    expect((await handler(event('student-b', 'GET', `/me/documents/${document.document.documentId}`))).statusCode).toBe(404);
    const download = await handler(event('student-a', 'GET', `/me/documents/${document.document.documentId}`));
    expect(body<{ downloadUrl: string }>(download).downloadUrl).toContain('X-Amz-Signature');

    await users.putPreferences({ userId: 'student-a', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    const deleted = await handler(event('student-a', 'DELETE', '/me'));
    expect(deleted.statusCode).toBe(204);
    expect(await users.getPreferences('student-a')).toBeUndefined();
    expect(await users.listDocuments('student-a')).toEqual([]);
    expect(s3Send.mock.calls.map(([command]) => command)).toContainEqual(expect.any(DeleteObjectCommand));
    expect(cognitoSend.mock.calls.map(([command]) => command)).toContainEqual(expect.any(AdminDeleteUserCommand));
    expect((s3Send.mock.calls[0]?.[0] as DeleteObjectCommand).input).toMatchObject({ Bucket: 'private-documents', Key: document.document.objectKey });
    expect((cognitoSend.mock.calls[0]?.[0] as AdminDeleteUserCommand).input).toMatchObject({ UserPoolId: 'pool-id', Username: 'student-a' });
  });
});
