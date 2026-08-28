import { describe, expect, it } from 'vitest';
import {
  matchClickedGmailApplication,
  matchGmailApplication,
  matchRecentClickedGmailApplication,
  type GmailMetadata,
} from '../src/gmail-matcher.js';
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

const recent = (job: Internship, clickedAt = '2026-08-25T11:55:00.000Z', expiresAt = '2026-08-26T12:55:00.000Z') => ({
  job, clickedAt, expiresAt,
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

  it.each(['New job alert from Northstar Labs', 'Your Northstar Labs application is incomplete', 'Your application was saved as a draft'])(
    'excludes alerts and unfinished applications: %s', (subject) => expect(matchGmailApplication(metadata(subject), [role()]).outcome).toBe('ignore'),
  );

  it('ignores malformed and unrelated headers', () => {
    expect(matchGmailApplication({ subject: '', sender: '', receivedAt: 'invalid', labels: [] }, [role()]).outcome).toBe('ignore');
  });

  it.each([
    {
      name: 'D. E. Shaw',
      message: metadata('Your application to the D. E. Shaw group', 'D. E. Shaw Recruiting <recruiting@deshaw.com>'),
      clickedRole: role({ company: 'D. E. Shaw & Co.', title: 'Software Developer Intern' }),
    },
    {
      name: 'American Express',
      message: metadata('Your application to Amex', 'American Express Careers <careers@americanexpress.com>'),
      clickedRole: role({ company: 'American Express', title: 'Software Engineer Intern' }),
    },
    {
      name: 'Postman',
      message: metadata('John, thanks for wanting to become a Postmanaut!', 'Postman <notifications@greenhouse-mail.io>'),
      clickedRole: role({ company: 'Postman', title: 'Software Engineering Intern' }),
    },
    {
      name: 'IMC',
      message: metadata("We've got it! Your application for Software Engineer, Early Career at IMC is underway", 'IMC Careers <careers@imc.com>'),
      clickedRole: role({ company: 'IMC', title: 'Software Engineer, Early Career' }),
    },
    {
      name: 'Five Rings',
      message: metadata('Regarding the Summer Intern 2027 - Software Developer role at Five Rings', 'Five Rings <notifications@greenhouse-mail.io>'),
      clickedRole: role({ company: 'Five Rings', title: 'Summer Intern 2027 - Software Developer' }),
    },
  ])('uses the click window to accept liberal historical receipt language: $name', ({ message, clickedRole }) => {
    expect(matchRecentClickedGmailApplication(message, [recent(clickedRole)])).toMatchObject({
      outcome: 'applied', candidate: { jobId: clickedRole.jobId },
    });
  });

  it('does not inspect messages before the click or after the 25-hour window', () => {
    const confirmation = metadata('Thank you for applying to Northstar Labs');
    expect(matchRecentClickedGmailApplication(confirmation, [recent(role(), '2026-08-25T12:00:01.000Z')]).outcome).toBe('ignore');
    expect(matchRecentClickedGmailApplication(confirmation, [recent(role(), '2026-08-24T00:00:00.000Z', '2026-08-25T11:59:59.000Z')]).outcome).toBe('ignore');
  });

  it.each([
    ['Radix Trading', 'Thank you for applying to Hudson River Trading', 'Hudson River Trading <jobs@hudsonrivertrading.com>'],
    ['DV Trading', 'Thank you for applying to Radix Trading', 'Radix Trading <jobs@radix-trading.com>'],
    ['X Development', 'Thank you for applying to Ciena', 'Ciena <jobs@ciena.com>'],
    ['Junior AI', 'Thank you for applying to BMO Junior Developer', 'BMO <jobs@bmo.com>'],
  ])('does not auto-apply %s from an unrelated employer receipt', (company, subject, sender) => {
    const result = matchRecentClickedGmailApplication(metadata(subject, sender), [recent(role({ company }))]);
    expect(result.outcome).not.toBe('applied');
  });

  it('does not auto-apply on a shared provider alone', () => {
    const result = matchRecentClickedGmailApplication(
      metadata('Your application for a role is complete', 'Unrelated Company <notifications@greenhouse-mail.io>'),
      [recent(role())],
    );
    expect(result).toMatchObject({ outcome: 'review', candidates: [{ confidenceScore: 4 }] });
  });

  it('scores IBM submitted-application wording above the auto-apply threshold', () => {
    const ibm = role({ company: 'IBM', title: 'Data and AI Intern 2027' });
    const result = matchRecentClickedGmailApplication(metadata(
      'You have successfully submitted your IBM job application - Data and AI Intern 2027',
      'IBM Talent Acquisition <talent@ibm.com>',
    ), [recent(ibm)]);
    expect(result).toMatchObject({ outcome: 'applied', candidate: { jobId: ibm.jobId, confidenceScore: 10 } });
  });

  it('uses message content when a generic subject does not identify the role', () => {
    const result = matchRecentClickedGmailApplication({
      ...metadata('Application confirmation'),
      content: 'We received your application for Software Engineering Intern at Northstar Labs.',
    }, [recent(role())]);
    expect(result).toMatchObject({
      outcome: 'applied',
      candidate: { jobId: 'job-1', signals: expect.arrayContaining(['employer', 'title']) },
    });
  });

  it.each([
    'Application confirmation — Northstar Labs',
    'We got your application — Northstar Labs',
    'Your application is in — Northstar Labs',
    'Receipt of application — Northstar Labs',
    'Confirmation of your application — Northstar Labs',
    'Submission confirmed — Northstar Labs',
    'Your candidate application has been successfully submitted to Northstar Labs',
  ])('accepts a common receipt construction inside the Apply window: %s', (subject) => {
    expect(matchRecentClickedGmailApplication(metadata(subject), [recent(role())]).outcome).toBe('applied');
  });

  it('holds a receipt explicitly naming another candidate for review', () => {
    expect(matchRecentClickedGmailApplication(metadata(
      'Application received for Jordan Lee — Northstar Labs',
      'jobs@northstarlabs.com',
    ), [recent(role())])).toMatchObject({ outcome: 'review' });
  });

  it('does not auto-apply a matching title sent through a shared ATS for another employer', () => {
    const result = matchRecentClickedGmailApplication({
      ...metadata('Application confirmation', 'Other Company <notifications@greenhouse-mail.io>'),
      content: 'We received your application for Software Engineering Intern at Other Company.',
    }, [recent(role())]);
    expect(result).toMatchObject({
      outcome: 'review',
      candidates: [{ jobId: 'job-1', signals: ['title', 'provider'] }],
    });
  });

  it.each([
    'An update from Northstar Labs on your application to Software Engineering Intern',
    'Interview invitation — your application to Northstar Labs',
    'Your application to Northstar Labs was rejected',
    'Complete your coding assessment for Software Engineering Intern at Northstar Labs',
    'Offer for Software Engineering Intern at Northstar Labs',
  ])('uses an authoritative downstream stage as evidence of application: %s', (subject) => {
    expect(matchRecentClickedGmailApplication(metadata(subject), [recent(role())]).outcome).toBe('applied');
  });

  it.each([
    'Your Northstar Labs application is incomplete',
    'Your Northstar Labs application was saved as a draft',
    'Your application for Northstar Labs: action required',
    'Please verify your identity for your Northstar Labs application',
    'Application received — please finish your Northstar Labs profile',
  ])('does not infer submission from unfinished or verification mail: %s', (subject) => {
    expect(matchRecentClickedGmailApplication(metadata(subject), [recent(role())]).outcome).toBe('ignore');
  });

  it('reviews simultaneous same-employer Apply clicks rather than guessing', () => {
    const result = matchRecentClickedGmailApplication(metadata('Your application to Northstar Labs', 'jobs@northstarlabs.com'), [
      recent(role()), recent(role({ jobId: 'job-2', title: 'Data Science Intern' })),
    ]);
    expect(result.outcome).toBe('review');
  });
});
