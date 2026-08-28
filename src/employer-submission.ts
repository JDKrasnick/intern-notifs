import { fingerprint, jobId, normalizeUrl } from './core/normalize.js';
import type { EmployerSubmission } from './employer-types.js';
import { evidenceHash, metadataCompleteness } from './catalog-admission.js';
import type { CatalogAdmission } from './types.js';
import type { Internship, InternshipProgramType, WorkMode } from './types.js';

const programTypes: InternshipProgramType[] = ['internship', 'co-op', 'apprenticeship', 'new-grad', 'entry-level'];
const workModes: WorkMode[] = ['remote', 'hybrid', 'onsite'];
const workAuthorizationStatuses = ['sponsorship-available', 'no-sponsorship', 'existing-authorization-required', 'citizenship-required', 'unknown'];

function requiredText(body: Record<string, unknown>, field: string, max = 300): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} is required`);
  return value.trim();
}

export function validIanaTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

export function deadlineHasPassed(submission: Pick<EmployerSubmission, 'deadline' | 'deadlineTimezone'>, now = new Date()): boolean {
  if (submission.deadline === 'rolling') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(submission.deadline) || !submission.deadlineTimezone || !validIanaTimezone(submission.deadlineTimezone)) return true;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: submission.deadlineTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}` > submission.deadline;
}

export function destinationMatchesEmployer(value: string, domain: string, allowedHosts: readonly string[] = []): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.pathname || url.pathname === '/') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  const employerDomain = domain.toLowerCase().replace(/\.$/u, '');
  return host === employerDomain || host.endsWith(`.${employerDomain}`)
    || allowedHosts.some((candidate) => host === candidate.toLowerCase().replace(/\.$/u, ''));
}

export function parseEmployerSubmission(input: {
  body: Record<string, unknown>;
  organizationId: string;
  organizationName: string;
  organizationDomain: string;
  userId: string;
  allowedApplicationHosts?: readonly string[];
  id?: string;
  now?: string;
}): EmployerSubmission {
  const { body } = input;
  if ('description' in body || 'jobDescription' in body || 'fullDescription' in body) throw new Error('Full job descriptions are not accepted');
  const title = requiredText(body, 'title');
  const company = requiredText(body, 'company');
  if (company.toLowerCase() !== input.organizationName.trim().toLowerCase()) throw new Error('company must match the verified organization');
  const programType = requiredText(body, 'programType', 40);
  if (!programTypes.includes(programType as InternshipProgramType)) throw new Error('programType is not supported');
  const workMode = requiredText(body, 'workMode', 20);
  if (!workModes.includes(workMode as WorkMode)) throw new Error('workMode is not supported');
  const applicationUrl = requiredText(body, 'applicationUrl', 2_048);
  if (!destinationMatchesEmployer(applicationUrl, input.organizationDomain, input.allowedApplicationHosts)) {
    throw new Error('applicationUrl must be a verified employer-controlled destination');
  }
  const deadline = requiredText(body, 'deadline', 20);
  const deadlineTimezone = typeof body.deadlineTimezone === 'string' ? body.deadlineTimezone : undefined;
  if (deadline !== 'rolling' && (!/^\d{4}-\d{2}-\d{2}$/u.test(deadline) || Number.isNaN(Date.parse(`${deadline}T00:00:00Z`)))) throw new Error('deadline must be rolling or an ISO date');
  if (deadline !== 'rolling' && (!deadlineTimezone || !validIanaTimezone(deadlineTimezone))) throw new Error('A valid IANA deadlineTimezone is required for date deadlines');
  const workAuthorization = requiredText(body, 'workAuthorization', 40);
  if (!workAuthorizationStatuses.includes(workAuthorization)) throw new Error('workAuthorization is not supported');
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id ?? crypto.randomUUID(), organizationId: input.organizationId, title, company,
    programType, discipline: requiredText(body, 'discipline', 80), location: requiredText(body, 'location'),
    workMode, season: requiredText(body, 'season', 80), applicationUrl,
    deadline: deadline as EmployerSubmission['deadline'], ...(deadlineTimezone ? { deadlineTimezone } : {}),
    workAuthorization: workAuthorization as EmployerSubmission['workAuthorization'],
    ...(typeof body.compensation === 'string' && body.compensation.trim() ? { compensation: body.compensation.trim().slice(0, 300) } : {}),
    ...(typeof body.graduationWindow === 'string' && body.graduationWindow.trim() ? { graduationWindow: body.graduationWindow.trim().slice(0, 100) } : {}),
    ...(typeof body.privateReviewNote === 'string' && body.privateReviewNote.trim() ? { privateReviewNote: body.privateReviewNote.trim().slice(0, 1_000) } : {}),
    state: body.submit === true ? 'pending-review' : 'draft', createdBy: input.userId, createdAt: now, updatedAt: now,
  };
}

export function publishedInternshipFromSubmission(submission: EmployerSubmission, now: string): Internship {
  if (submission.state !== 'published') throw new Error('Only published submissions can enter the catalog');
  if (deadlineHasPassed(submission, new Date(now))) throw new Error('Submission deadline has passed');
  const normalizedUrl = normalizeUrl(submission.applicationUrl);
  const key = fingerprint(submission.company, submission.title, submission.location, submission.season);
  const applicationDeadline = submission.deadline === 'rolling'
    ? { kind: 'rolling' as const }
    : { kind: 'date' as const, date: submission.deadline, timezone: submission.deadlineTimezone! };
  const metadata = metadataCompleteness({ title: submission.title, locations: [submission.location] });
  if (!metadata.complete) throw new Error('Submission display metadata is incomplete');
  const destination = {
    classification: 'application-form' as const,
    candidateUrl: submission.applicationUrl,
    finalUrl: submission.applicationUrl,
    provider: 'employer-submission' as const,
    expectedPostingId: submission.id,
    inspectedAt: submission.publishedAt ?? now,
    applicationFormPresent: true,
    evidenceHash: evidenceHash({ organizationId: submission.organizationId, submissionId: submission.id, applicationUrl: submission.applicationUrl }),
  };
  const admission: CatalogAdmission = {
    canonicalEmployer: { id: submission.organizationId, displayName: submission.company },
    employerResolution: 'resolved', postingAttribution: 'attributed', destination, metadata,
    catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: now,
    evidenceObservedAt: destination.inspectedAt,
  };
  return {
    jobId: jobId(normalizedUrl, key), company: submission.company, title: submission.title,
    location: submission.location, locations: [submission.location], season: submission.season,
    applyUrl: submission.applicationUrl, normalizedUrl, applicationUrlValidatedAt: destination.inspectedAt, fingerprint: key,
    compensation: { raw: submission.compensation ?? '' }, workAuthorizationStatus: submission.workAuthorization,
    applicationDeadline, programType: submission.programType as InternshipProgramType,
    workMode: submission.workMode as WorkMode,
    sourceReferences: [{
      sourceId: `employer:${submission.organizationId}:submission:${submission.id}`,
      provenance: 'employer-submitted', externalId: submission.id, document: submission.id,
      sourceUrl: submission.applicationUrl, row: 1, company: submission.company, title: submission.title,
      location: submission.location, locations: [submission.location], season: submission.season,
      applyUrl: submission.applicationUrl, compensation: { raw: submission.compensation ?? '' }, state: 'open', technical: true,
      firstAttachedAt: submission.publishedAt ?? now, firstAttachedAtPrecision: 'exact', workMode: submission.workMode as Exclude<WorkMode, 'unspecified'>,
      admission,
    }], technical: true, open: true, firstSeenAt: submission.publishedAt ?? now,
    admission,
    catalogVisibleAt: submission.publishedAt ?? now, catalogRecency: 'normal', lastSeenAt: now,
    notification: { smsPending: true, digestPending: true },
  };
}
