import { describe, expect, it } from 'vitest';
import { deadlineHasPassed, destinationMatchesEmployer, parseEmployerSubmission, publishedInternshipFromSubmission } from '../src/employer-submission.js';

const base = {
  title: 'Software Engineering Intern', company: 'Acme', programType: 'internship', discipline: 'software',
  location: 'New York, NY', workMode: 'hybrid', season: 'summer-2027',
  applicationUrl: 'https://careers.acme.example/apply/123', deadline: '2027-02-10',
  deadlineTimezone: 'America/New_York', workAuthorization: 'unknown', submit: true,
};

describe('employer direct submissions', () => {
  it('accepts only employer-controlled HTTPS destinations', () => {
    expect(destinationMatchesEmployer(base.applicationUrl, 'acme.example')).toBe(true);
    expect(destinationMatchesEmployer('https://evil.example/apply/123', 'acme.example')).toBe(false);
    expect(destinationMatchesEmployer('http://careers.acme.example/apply/123', 'acme.example')).toBe(false);
  });

  it('rejects full descriptions and incomplete date deadlines', () => {
    const input = { organizationId: 'org-1', organizationName: 'Acme', organizationDomain: 'acme.example', userId: 'owner', now: '2026-08-26T12:00:00Z' };
    expect(() => parseEmployerSubmission({ ...input, body: { ...base, description: 'not stored' } })).toThrow('descriptions');
    expect(() => parseEmployerSubmission({ ...input, body: { ...base, deadlineTimezone: undefined } })).toThrow('IANA');
  });

  it('closes date deadlines only after the local calendar date ends', () => {
    const deadline = { deadline: '2027-02-10' as const, deadlineTimezone: 'America/New_York' };
    expect(deadlineHasPassed(deadline, new Date('2027-02-11T04:59:59Z'))).toBe(false);
    expect(deadlineHasPassed(deadline, new Date('2027-02-11T05:00:00Z'))).toBe(true);
  });

  it('publishes structured metadata and explicit employer provenance without a description', () => {
    const submission = parseEmployerSubmission({ body: base, organizationId: 'org-1', organizationName: 'Acme', organizationDomain: 'acme.example', userId: 'owner', id: 'sub-1', now: '2026-08-26T12:00:00Z' });
    const role = publishedInternshipFromSubmission({ ...submission, state: 'published', publishedAt: '2026-08-27T12:00:00Z' }, '2026-08-27T12:00:00Z');
    expect(role.sourceReferences[0]).toMatchObject({ provenance: 'employer-submitted', externalId: 'sub-1' });
    expect(role.workAuthorizationStatus).toBe('unknown');
    expect(role.applicationDeadline).toEqual({ kind: 'date', date: '2027-02-10', timezone: 'America/New_York' });
    expect(role).not.toHaveProperty('description');
  });
});
