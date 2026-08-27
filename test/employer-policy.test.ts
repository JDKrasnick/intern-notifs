import { describe, expect, it } from 'vitest';
import {
  automaticPublishingEligibility,
  canAutomaticallyPublish,
  canManageEmployer,
  emailMatchesEmployerDomain,
  invitationIsUsable,
  verificationExpiresAt,
} from '../src/employer-types.js';

describe('employer trust policy', () => {
  it('matches only the exact claimed email domain', () => {
    expect(emailMatchesEmployerDomain('owner@Example.COM', 'example.com')).toBe(true);
    expect(emailMatchesEmployerDomain('owner@jobs.example.com', 'example.com')).toBe(false);
    expect(emailMatchesEmployerDomain('owner@example.com.evil.test', 'example.com')).toBe(false);
    expect(emailMatchesEmployerDomain('not-an-email', 'example.com')).toBe(false);
  });

  it('reserves membership and verification management for owners', () => {
    expect(canManageEmployer('owner', 'members')).toBe(true);
    expect(canManageEmployer('editor', 'members')).toBe(false);
    expect(canManageEmployer('editor', 'verification')).toBe(false);
    expect(canManageEmployer('editor', 'sources')).toBe(true);
    expect(canManageEmployer('editor', 'proposals')).toBe(true);
    expect(canManageEmployer('editor', 'submissions')).toBe(true);
    expect(canManageEmployer(undefined, 'submissions')).toBe(false);
  });

  it('enforces invitation and 180-day verification expiry boundaries', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    expect(invitationIsUsable({ expiresAt: '2026-08-26T12:00:00.001Z' }, now)).toBe(true);
    expect(invitationIsUsable({ expiresAt: now.toISOString() }, now)).toBe(false);
    expect(invitationIsUsable({ expiresAt: '2027-01-01T00:00:00.000Z', acceptedAt: now.toISOString() }, now)).toBe(false);
    expect(verificationExpiresAt('2026-01-01T00:00:00.000Z')).toBe('2026-06-30T00:00:00.000Z');
  });

  it('requires the full eligibility history and an explicit reviewer grant', () => {
    const now = new Date('2026-08-26T00:00:00.000Z');
    const eligible = automaticPublishingEligibility({
      verifiedSince: '2026-05-01T00:00:00.000Z',
      approvedSubmissionCount: 10,
    }, now);
    expect(eligible).toEqual({ eligible: true, reasons: [] });
    const organization = { id: 'org', name: 'Example', domain: 'example.com', state: 'active' as const,
      createdAt: now.toISOString(), updatedAt: now.toISOString() };
    const verification = { organizationId: 'org', state: 'verified' as const, updatedAt: now.toISOString(),
      expiresAt: '2026-09-01T00:00:00.000Z' };
    expect(canAutomaticallyPublish({ organization, verification, eligibility: eligible }, now)).toBe(false);
    expect(canAutomaticallyPublish({ organization, verification, eligibility: eligible,
      privilege: { organizationId: 'org', automaticPublishingEnabled: true, updatedAt: now.toISOString() } }, now)).toBe(true);

    expect(automaticPublishingEligibility({
      verifiedSince: '2026-05-01T00:00:00.000Z', approvedSubmissionCount: 12,
      latestUpheldReportAt: '2026-08-01T00:00:00.000Z', latestQuarantineAt: '2026-01-01T00:00:00.000Z',
    }, now)).toEqual({ eligible: false, reasons: ['recent-upheld-report'] });
  });
});
