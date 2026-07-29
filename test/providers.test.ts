import { describe, expect, it } from 'vitest';
import { EmployerIntegrationRegistry, GreenhouseJobBoardAdapter } from '../src/providers.js';
import type { ApplicantProfile, Internship } from '../src/types.js';

const job: Internship = { jobId: 'job', company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', normalizedUrl: 'https://boards.greenhouse.io/acme/jobs/1', fingerprint: 'job', compensation: { raw: '' }, sourceReferences: [], open: true, firstSeenAt: '2026-07-19T00:00:00.000Z', lastSeenAt: '2026-07-19T00:00:00.000Z', notification: { smsPending: false, digestPending: false } };
const profile: ApplicantProfile = { userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: '2026-07-19T00:00:00.000Z' };

describe('employer submission trust boundary', () => {
  it('uses the official form until an employer integration is explicitly enabled', () => {
    const adapter = new GreenhouseJobBoardAdapter();
    expect(new EmployerIntegrationRegistry([adapter]).applyMode(job)).toBe('official-form');
    expect(new EmployerIntegrationRegistry([adapter], new Set(['greenhouse'])).applyMode(job)).toBe('partner');
  });

  it('requires the partner fields and never exposes direct submit before authorization', async () => {
    const adapter = new GreenhouseJobBoardAdapter();
    expect(adapter.validateDraft(profile, job)).toEqual(expect.arrayContaining(['resumeDocumentId']));
    await expect(adapter.submit(profile, job)).rejects.toThrow('disabled');
    expect(await adapter.requestUserReview(profile, job)).toEqual({ approved: false });
  });
});
