export type ApplicationExecutionMode = 'headed' | 'headless';

export type AssistanceEligibility =
  | 'headed-supported'
  | 'remote-supported'
  | 'partner-only'
  | 'manual-only';

export type ApplicationSessionStatus =
  | 'created'
  | 'filling'
  | 'needs-input'
  | 'awaiting-user-review'
  | 'awaiting-user-verification'
  | 'ready-for-user-submit'
  | 'submitted'
  | 'failed'
  | 'cancelled';

export type ApplicationFieldClassification =
  | 'standard'
  | 'sensitive'
  | 'voluntary-self-identification';

/**
 * A field plan deliberately contains references and masked previews, not the
 * applicant's raw answers. Runners resolve values only inside their ephemeral
 * execution environment.
 */
export interface ApplicationFieldDraft {
  key: string;
  label: string;
  required: boolean;
  resolved: boolean;
  classification: ApplicationFieldClassification;
  confidence: 'exact' | 'inferred' | 'unknown';
  valueRef?: { source: 'profile' | 'reusable-answer' | 'document' | 'user'; key: string };
  maskedPreview?: string;
}

export type VerificationReason = 'captcha' | 'mfa' | 'email' | 'identity' | 'portal-login' | 'other';

export interface ApplicationSession {
  sessionId: string;
  userId: string;
  applicationId: string;
  jobId: string;
  mode: ApplicationExecutionMode;
  status: ApplicationSessionStatus;
  /** Increments for every accepted event; clients must use it optimistically. */
  version: number;
  fields: ApplicationFieldDraft[];
  /** A deterministic, browser-safe digest of the masked field plan. */
  fieldPlanDigest: string;
  /** Cleared whenever the field plan changes, so approval is never stale. */
  approvalDigest?: string;
  verification?: {
    reason: VerificationReason;
    requestedAt: string;
    completedAt?: string;
    resumeStatus: 'filling' | 'needs-input' | 'awaiting-user-review' | 'ready-for-user-submit';
  };
  reviewedAt?: string;
  submittedAt?: string;
  failureMessage?: string;
  runnerLifecycle: 'not-started' | 'active' | 'paused' | 'stopped';
  /** Active sessions expire quickly; metadata is retained only for 30 days. */
  expiresAt: string;
  metadataExpiresAt: string;
  /** Hashed, short-lived credentials only; never return this to a client. */
  handoff?: {
    codeHash: string;
    codeExpiresAt: string;
    consumedAt?: string;
    bearerHash?: string;
    bearerExpiresAt?: string;
  };
  eventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type ApplicationSessionEvent =
  | { type: 'start' }
  | { type: 'fill-completed'; fields: ApplicationFieldDraft[] }
  | { type: 'answers-updated'; fields: ApplicationFieldDraft[] }
  | { type: 'review-approved'; actor: 'user' }
  | { type: 'verification-required'; reason: VerificationReason }
  | { type: 'verification-completed'; actor: 'user' }
  | { type: 'submission-confirmed'; actor: 'user' }
  | { type: 'fail'; message: string }
  | { type: 'cancel' };

export interface ApplicationSessionEventInput {
  eventId: string;
  expectedVersion: number;
  event: ApplicationSessionEvent;
}

const activeSessionLifetimeMs = 60 * 60 * 1000;
const metadataLifetimeMs = 30 * 24 * 60 * 60 * 1000;

function isoAfter(iso: string, milliseconds: number) {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString();
}

/**
 * This is a change detector, not a security primitive. It deliberately avoids
 * Node-only crypto so the same reducer can run in a WebExtension.
 */
export function digestFieldPlan(fields: ApplicationFieldDraft[]) {
  const canonical = fields
    .map((field) => [field.key, field.required, field.resolved, field.classification, field.confidence, field.valueRef?.source ?? '', field.valueRef?.key ?? '', field.maskedPreview ?? ''].join('|'))
    .sort()
    .join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createApplicationSession(input: {
  sessionId: string;
  userId: string;
  applicationId: string;
  jobId: string;
  mode: ApplicationExecutionMode;
  now: string;
}): ApplicationSession {
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    mode: input.mode,
    status: 'created',
    version: 0,
    fields: [],
    fieldPlanDigest: digestFieldPlan([]),
    runnerLifecycle: 'not-started',
    expiresAt: isoAfter(input.now, activeSessionLifetimeMs),
    metadataExpiresAt: isoAfter(input.now, metadataLifetimeMs),
    eventIds: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function hasUnresolvedRequiredFields(fields: ApplicationFieldDraft[]) {
  return fields.some((field) => field.required && !field.resolved);
}

function isTerminal(status: ApplicationSessionStatus) {
  return status === 'submitted' || status === 'failed' || status === 'cancelled';
}

function assertUser(actor: 'user', action: string) {
  if (actor !== 'user') throw new Error(`${action} requires the user`);
}

function transitionError(status: ApplicationSessionStatus, event: ApplicationSessionEvent['type']): never {
  throw new Error(`Cannot apply ${event} while application session is ${status}`);
}

/**
 * Advances only orchestration state. It intentionally has no submit callback:
 * non-partner runners can fill and navigate, but only the user can operate the
 * employer's final submit control and then confirm the outcome here.
 */
export function transitionApplicationSession(
  session: ApplicationSession,
  event: ApplicationSessionEvent,
  now: string,
): ApplicationSession {
  if (isTerminal(session.status)) transitionError(session.status, event.type);

  if (event.type === 'fail') {
    return { ...session, status: 'failed', runnerLifecycle: 'stopped', failureMessage: event.message.slice(0, 1000), updatedAt: now };
  }
  if (event.type === 'cancel') return { ...session, status: 'cancelled', runnerLifecycle: 'stopped', updatedAt: now };

  if (event.type === 'verification-required') {
    if (session.status === 'created' || session.status === 'awaiting-user-verification') {
      transitionError(session.status, event.type);
    }
    return {
      ...session,
      status: 'awaiting-user-verification',
      runnerLifecycle: 'paused',
      verification: { reason: event.reason, requestedAt: now, resumeStatus: session.status },
      updatedAt: now,
    };
  }

  switch (session.status) {
    case 'created':
      if (event.type !== 'start') transitionError(session.status, event.type);
      return { ...session, status: 'filling', runnerLifecycle: 'active', updatedAt: now };
    case 'filling':
      if (event.type !== 'fill-completed') transitionError(session.status, event.type);
      return {
        ...session,
        fields: event.fields,
        fieldPlanDigest: digestFieldPlan(event.fields),
        approvalDigest: undefined,
        status: hasUnresolvedRequiredFields(event.fields) ? 'needs-input' : 'awaiting-user-review',
        updatedAt: now,
      };
    case 'needs-input':
      if (event.type !== 'answers-updated') transitionError(session.status, event.type);
      return {
        ...session,
        fields: event.fields,
        fieldPlanDigest: digestFieldPlan(event.fields),
        approvalDigest: undefined,
        status: hasUnresolvedRequiredFields(event.fields) ? 'needs-input' : 'awaiting-user-review',
        updatedAt: now,
      };
    case 'awaiting-user-review':
      if (event.type === 'answers-updated') {
        return {
          ...session,
          fields: event.fields,
          fieldPlanDigest: digestFieldPlan(event.fields),
          approvalDigest: undefined,
          status: hasUnresolvedRequiredFields(event.fields) ? 'needs-input' : 'awaiting-user-review',
          updatedAt: now,
        };
      }
      if (event.type !== 'review-approved') transitionError(session.status, event.type);
      assertUser(event.actor, 'Review approval');
      return { ...session, status: 'ready-for-user-submit', approvalDigest: session.fieldPlanDigest, reviewedAt: now, updatedAt: now };
    case 'awaiting-user-verification':
      if (event.type !== 'verification-completed') transitionError(session.status, event.type);
      assertUser(event.actor, 'Portal verification');
      if (!session.verification) throw new Error('Application session is missing its verification checkpoint');
      return {
        ...session,
        status: session.verification.resumeStatus,
        runnerLifecycle: 'active',
        verification: { ...session.verification, completedAt: now },
        updatedAt: now,
      };
    case 'ready-for-user-submit':
      if (event.type === 'answers-updated') {
        return {
          ...session,
          fields: event.fields,
          fieldPlanDigest: digestFieldPlan(event.fields),
          approvalDigest: undefined,
          status: hasUnresolvedRequiredFields(event.fields) ? 'needs-input' : 'awaiting-user-review',
          updatedAt: now,
        };
      }
      if (event.type !== 'submission-confirmed') transitionError(session.status, event.type);
      assertUser(event.actor, 'Submission confirmation');
      if (session.approvalDigest !== session.fieldPlanDigest) throw new Error('Application answers changed and need review');
      return { ...session, status: 'submitted', runnerLifecycle: 'stopped', submittedAt: now, updatedAt: now };
    default:
      return transitionError(session.status, event.type);
  }
}
