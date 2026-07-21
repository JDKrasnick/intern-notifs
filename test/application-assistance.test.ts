import { describe, expect, it } from 'vitest';
import { assistanceAvailability } from '../src/application-assistance.js';

describe('reviewed application assistance registry', () => {
  it('supports the reviewed Greenhouse and direct Lever form routes', () => {
    expect(assistanceAvailability({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' })).toMatchObject({
      eligibility: 'headed-supported', reasonCode: 'greenhouse-headed-pilot', primaryAction: 'assist-in-safari',
    });
    expect(assistanceAvailability({ applyUrl: 'https://jobs.lever.co/acme/123/apply' })).toMatchObject({
      eligibility: 'headed-supported', reasonCode: 'lever-headed-pilot', primaryAction: 'assist-in-safari',
    });
  });

  it('fails closed for incomplete Lever URLs, prohibited destinations, arbitrary sites, and partner submission routes', () => {
    expect(assistanceAvailability({ applyUrl: 'https://jobs.lever.co/acme/123' })).toMatchObject({ eligibility: 'manual-only', reasonCode: 'destination-not-reviewed' });
    expect(assistanceAvailability({ applyUrl: 'https://www.linkedin.com/jobs/view/123' })).toMatchObject({ eligibility: 'manual-only', reasonCode: 'destination-policy-prohibits-automation' });
    expect(assistanceAvailability({ applyUrl: 'https://apply.example.com/role' })).toMatchObject({ eligibility: 'manual-only', reasonCode: 'destination-not-reviewed' });
    expect(assistanceAvailability({ applyUrl: 'https://jobs.lever.co/acme/123/apply' }, 'partner')).toMatchObject({ eligibility: 'partner-only', reasonCode: 'partner-submission-requires-employer-authorization' });
  });
});
