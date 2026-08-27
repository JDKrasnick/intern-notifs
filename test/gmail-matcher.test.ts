import { describe, expect, it } from 'vitest';
import { matchClickedGmailApplication, matchGmailApplication, type GmailMetadata } from '../src/gmail-matcher.js';
import type { Internship } from '../src/types.js';

function role(overrides: Partial<Internship> = {}): Internship {
  return {
    jobId: 'job-1', company: 'Northstar Labs', title: 'Software Engineering Intern', location: 'New York', season: 'Summer 2027',
    applyUrl: 'https://boards.greenhouse.io/northstar/jobs/12345', normalizedUrl: 'https://boards.greenhouse.io/northstar/jobs/12345',
    fingerprint: 'fingerprint', technical: true, open: true, firstSeenAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-08-25T00:00:00.000Z',
    compensation: { raw: 'Not listed' }, sourceReferences: [], notification: { smsPending: false, digestPending: false },
    postingIdentity: { provider: 'greenhouse', tenant: 'northstar', providerPostingId: '12345', canonicalApplicationUrl: 'https://boards.greenhouse.io/northstar/jobs/12345', canonicalJobId: 'job-1', aliases: [] },
    ...overrides,
  } as Internship;
}

const metadata = (subject: string, sender = 'Northstar Recruiting <notifications@greenhouse-mail.io>'): GmailMetadata => ({
  subject, sender, receivedAt: '2026-08-25T12:00:00.000Z', labels: ['INBOX'],
});

describe('Gmail application matcher', () => {
  it.each([
    'Thank you for applying to Software Engineering Intern at Northstar Labs',
    'Application received — Northstar Labs Software Engineering Intern',
    'Solicitud recibida — Northstar Labs Software Engineering Intern',
  ])('auto-applies a unique confirmation: %s', (subject) => {
    const result = matchGmailApplication(metadata(subject), [role()]);
    expect(result.outcome).toBe('applied');
  });

  it('sends an ambiguous company-only confirmation to review', () => {
    const result = matchGmailApplication(metadata('We received your application at Northstar Labs', 'jobs@northstarlabs.com'), [
      role(), role({ jobId: 'job-2', title: 'Data Science Intern' }),
    ]);
    expect(result.outcome).toBe('review');
  });

  it('does not treat an employer name and matching provider tenant as independent role evidence', () => {
    const result = matchGmailApplication(metadata('We received your application at Northstar Labs'), [role()]);
    expect(result).toMatchObject({
      outcome: 'review',
      candidates: [{ jobId: 'job-1', signals: ['employer', 'provider-tenant'] }],
    });
  });

  it('uses the Apply click to resolve a single company-only confirmation', () => {
    const result = matchClickedGmailApplication(metadata('We received your application at Northstar Labs', 'jobs@northstarlabs.com'), [role()]);
    expect(result).toMatchObject({ outcome: 'applied', candidate: { jobId: 'job-1' } });
  });

  it('keeps company-only confirmations ambiguous when multiple clicked roles match', () => {
    const result = matchClickedGmailApplication(metadata('We received your application at Northstar Labs', 'jobs@northstarlabs.com'), [
      role(), role({ jobId: 'job-2', title: 'Data Science Intern' }),
    ]);
    expect(result).toMatchObject({ outcome: 'review' });
  });

  it.each([
    role({ company: 'ING', postingIdentity: { provider: 'greenhouse', tenant: 'ing', providerPostingId: '12345', canonicalApplicationUrl: 'https://boards.greenhouse.io/ing/jobs/12345', canonicalJobId: 'job-1', aliases: [] } }),
    role({ company: 'Exa', postingIdentity: { provider: 'greenhouse', tenant: 'exa', providerPostingId: '12345', canonicalApplicationUrl: 'https://boards.greenhouse.io/exa/jobs/12345', canonicalJobId: 'job-1', aliases: [] } }),
  ])('does not match short employer identities inside unrelated words or domains', (clickedRole) => {
    const result = matchClickedGmailApplication(
      metadata('Thank you for applying to Software Engineering Intern', 'Recruiting <unrelated@example.com>'),
      [clickedRole],
    );
    expect(result.outcome).toBe('review');
  });

  it('still applies a SpaceX confirmation to the clicked SpaceX role', () => {
    const spacex = role({
      company: 'SpaceX',
      title: 'Summer 2027 Software Engineering Internship/Co-op',
      postingIdentity: { provider: 'greenhouse', tenant: 'spacex', providerPostingId: '8621757002', canonicalApplicationUrl: 'https://job-boards.greenhouse.io/spacex/jobs/8621757002', canonicalJobId: 'job-1', aliases: [] },
    });
    const result = matchClickedGmailApplication(metadata(
      'Thank you for applying to SpaceX Summer 2027 Software Engineering Internship/Co-op',
      'SpaceX Recruiting <notifications@greenhouse-mail.io>',
    ), [spacex]);
    expect(result).toMatchObject({ outcome: 'applied', candidate: { jobId: 'job-1' } });
  });

  it.each(['Interview invitation — Northstar Labs', 'Complete your coding assessment', 'New job alert from Northstar Labs', 'Your application was rejected'])(
    'excludes stage and alert mail: %s', (subject) => expect(matchGmailApplication(metadata(subject), [role()]).outcome).toBe('ignore'),
  );

  it('ignores malformed and unrelated headers', () => {
    expect(matchGmailApplication({ subject: '', sender: '', receivedAt: 'invalid', labels: [] }, [role()]).outcome).toBe('ignore');
  });
});
