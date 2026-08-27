export const EMPLOYER_VERIFICATION_LIFETIME_DAYS = 180;
export const EMPLOYER_INVITATION_GRACE_DAYS = 7;

export type EmployerMembershipRole = 'owner' | 'editor';
export type EmployerOrganizationState = 'active' | 'closed';
export type EmployerVerificationState =
  | 'challenge-pending'
  | 'review-pending'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'revoked';
export type EmployerChallengeMethod = 'email-domain' | 'dns-txt' | 'well-known';
export type EmployerSourceProvider = 'greenhouse' | 'lever' | 'ashby' | 'json-ld' | 'sitemap' | 'embedded';
export type EmployerSourceState = 'pending-review' | 'shadow' | 'active' | 'stale' | 'disconnected' | 'quarantined' | 'rejected';
export type ReviewedSourceState = 'shadow' | 'active' | 'quarantined' | 'disabled';
export type EmployerProposalState = 'pending-review' | 'accepted' | 'rejected' | 'withdrawn';
export type EmployerSubmissionState = 'draft' | 'pending-review' | 'published' | 'rejected' | 'quarantined' | 'closed';
export type EmployerReportCategory = 'identity' | 'destination' | 'closed-role' | 'misleading-metadata' | 'other';
export type EmployerReportState = 'open' | 'upheld' | 'dismissed';
export type WorkAuthorizationStatus = 'sponsorship-available' | 'no-sponsorship' | 'existing-authorization-required' | 'citizenship-required' | 'unknown';

export interface EmployerOrganization {
  id: string;
  name: string;
  domain: string;
  state: EmployerOrganizationState;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  retainUntil?: string;
}

export interface EmployerMembership {
  organizationId: string;
  userId: string;
  role: EmployerMembershipRole;
  createdAt: string;
  updatedAt: string;
}

export interface EmployerInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: EmployerMembershipRole;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface EmployerVerificationChallenge {
  id: string;
  organizationId: string;
  method: EmployerChallengeMethod;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
}

export interface EmployerVerification {
  organizationId: string;
  state: EmployerVerificationState;
  challengeId?: string;
  reason?: string;
  reviewedBy?: string;
  updatedAt: string;
  verifiedAt?: string;
  expiresAt?: string;
}

export interface EmployerSourceConnection {
  id: string;
  organizationId: string;
  provider: EmployerSourceProvider;
  url: string;
  state: EmployerSourceState;
  reason?: string;
  sourceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewedSourceRecord {
  sourceId: string;
  provider: EmployerSourceProvider;
  organizationId?: string;
  config: Record<string, unknown>;
  evidence: Record<string, unknown>;
  state: ReviewedSourceState;
  createdAt: string;
  updatedAt: string;
}

export interface EmployerFieldProposal {
  id: string;
  organizationId: string;
  jobId: string;
  field: string;
  originalValue?: unknown;
  proposedValue: unknown;
  evidenceAt: string;
  state: EmployerProposalState;
  reason?: string;
  createdBy: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface EmployerSubmission {
  id: string;
  organizationId: string;
  title: string;
  company: string;
  programType: string;
  discipline: string;
  location: string;
  workMode: string;
  season: string;
  applicationUrl: string;
  deadline: string | 'rolling';
  deadlineTimezone?: string;
  workAuthorization: WorkAuthorizationStatus;
  compensation?: string;
  graduationWindow?: string;
  privateReviewNote?: string;
  state: EmployerSubmissionState;
  reason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  closedAt?: string;
}

export interface EmployerReport {
  id: string;
  organizationId: string;
  submissionId?: string;
  reporterKey: string;
  category: EmployerReportCategory;
  details?: string;
  state: EmployerReportState;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface EmployerPublishingPrivilege {
  organizationId: string;
  automaticPublishingEnabled: boolean;
  enabledAt?: string;
  enabledBy?: string;
  suspendedAt?: string;
  suspensionReason?: string;
  updatedAt: string;
}

export interface EmployerAuditEvent {
  id: string;
  organizationId: string;
  action: string;
  actorType: 'member' | 'reviewer' | 'system';
  actorId?: string;
  subjectType: string;
  subjectId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
  idempotencyKey?: string;
}

export interface AutomaticPublishingEvidence {
  verifiedSince?: string;
  approvedSubmissionCount: number;
  latestRejectionAt?: string;
  latestUpheldReportAt?: string;
  latestQuarantineAt?: string;
  latestVerificationLapseAt?: string;
}

export interface AutomaticPublishingEligibility {
  eligible: boolean;
  reasons: Array<'not-verified-90-days' | 'insufficient-approved-submissions' | 'recent-rejection' | 'recent-upheld-report' | 'recent-quarantine' | 'recent-verification-lapse'>;
}

function hostname(value: string): string | undefined {
  const candidate = value.trim().toLowerCase().replace(/\.$/u, '');
  if (!candidate || candidate.includes('/') || candidate.includes('@') || candidate.includes(':')) return undefined;
  return candidate;
}

export function emailMatchesEmployerDomain(email: string, domain: string): boolean {
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return false;
  const emailDomain = hostname(email.slice(separator + 1));
  const expected = hostname(domain);
  return emailDomain !== undefined && expected !== undefined && emailDomain === expected;
}

export function canManageEmployer(role: EmployerMembershipRole | undefined, resource: 'members' | 'verification' | 'sources' | 'proposals' | 'submissions'): boolean {
  if (!role) return false;
  return resource === 'members' || resource === 'verification' ? role === 'owner' : role === 'owner' || role === 'editor';
}

export function invitationIsUsable(invitation: Pick<EmployerInvitation, 'expiresAt' | 'acceptedAt' | 'revokedAt'>, now = new Date()): boolean {
  return !invitation.acceptedAt && !invitation.revokedAt && new Date(invitation.expiresAt).getTime() > now.getTime();
}

export function verificationIsActive(verification: Pick<EmployerVerification, 'state' | 'expiresAt'> | undefined, now = new Date()): boolean {
  return verification?.state === 'verified' && verification.expiresAt !== undefined && new Date(verification.expiresAt).getTime() > now.getTime();
}

export function verificationExpiresAt(verifiedAt: string): string {
  const expiry = new Date(verifiedAt);
  expiry.setUTCDate(expiry.getUTCDate() + EMPLOYER_VERIFICATION_LIFETIME_DAYS);
  return expiry.toISOString();
}

export function automaticPublishingEligibility(evidence: AutomaticPublishingEvidence, now = new Date()): AutomaticPublishingEligibility {
  const reasons: AutomaticPublishingEligibility['reasons'] = [];
  const threshold = now.getTime() - 90 * 24 * 60 * 60 * 1_000;
  if (!evidence.verifiedSince || new Date(evidence.verifiedSince).getTime() > threshold) reasons.push('not-verified-90-days');
  if (evidence.approvedSubmissionCount < 10) reasons.push('insufficient-approved-submissions');
  const recent: Array<[keyof AutomaticPublishingEvidence, AutomaticPublishingEligibility['reasons'][number]]> = [
    ['latestRejectionAt', 'recent-rejection'],
    ['latestUpheldReportAt', 'recent-upheld-report'],
    ['latestQuarantineAt', 'recent-quarantine'],
    ['latestVerificationLapseAt', 'recent-verification-lapse'],
  ];
  for (const [key, reason] of recent) {
    const value = evidence[key];
    if (typeof value === 'string' && new Date(value).getTime() >= threshold) reasons.push(reason);
  }
  return { eligible: reasons.length === 0, reasons };
}

export function canAutomaticallyPublish(input: {
  organization: EmployerOrganization;
  verification?: EmployerVerification;
  privilege?: EmployerPublishingPrivilege;
  eligibility: AutomaticPublishingEligibility;
}, now = new Date()): boolean {
  return input.organization.state === 'active'
    && verificationIsActive(input.verification, now)
    && input.privilege?.automaticPublishingEnabled === true
    && !input.privilege.suspendedAt
    && input.eligibility.eligible;
}
