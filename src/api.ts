import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { jobCategories, matchesJobFilter, parseJobFilter } from './core/filters.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import type { ApplicantProfile, ApplicationRecord, ApplicationStatus, DeviceToken, UserPreferences } from './types.js';
import { EmployerIntegrationRegistry } from './providers.js';
import { assistanceAvailability } from './application-assistance.js';
import { createApplicationSession, transitionApplicationSession, type ApplicationFieldDraft, type ApplicationSession, type ApplicationSessionEvent } from './application-automation.js';

type ApiEvent = { requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } }; http?: { method?: string }; requestId?: string }; rawPath?: string; routeKey?: string; pathParameters?: Record<string, string>; queryStringParameters?: Record<string, string>; headers?: Record<string, string | undefined>; body?: string | null };
type ApiResponse = { statusCode: number; headers: Record<string, string>; body: string };
const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
const reply = (statusCode: number, body: unknown): ApiResponse => ({ statusCode, headers, body: JSON.stringify(body) });
const parseBody = (event: ApiEvent): Record<string, unknown> => { try { return event.body ? JSON.parse(event.body) as Record<string, unknown> : {}; } catch { throw new Error('Request body must be valid JSON'); } };
const identity = (event: ApiEvent) => event.requestContext?.authorizer?.jwt?.claims?.sub;
const now = () => new Date().toISOString();
const statuses: ApplicationStatus[] = ['saved', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn'];
const hashSecret = (value: string) => createHash('sha256').update(value).digest('base64url');
const inMinutes = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
const isBefore = (left: string, right: string) => new Date(left).getTime() < new Date(right).getTime();

function safeSession(session: ApplicationSession) {
  const safe: Partial<ApplicationSession> = { ...session };
  delete safe.userId;
  delete safe.handoff;
  delete safe.eventIds;
  return safe;
}

function applicationSummary(application: ApplicationRecord, job: Awaited<ReturnType<NonNullable<InternshipStore['getJob']>>>) {
  return {
    ...application,
    ...(job ? {
      job: {
        jobId: job.jobId,
        company: job.company,
        title: job.title,
        location: job.location,
        season: job.season,
        applyUrl: job.applyUrl,
        open: job.open,
        assistance: assistanceAvailability(job, application.applyMode),
      },
    } : {}),
  };
}

function parseFields(value: unknown): ApplicationFieldDraft[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('event.fields must contain at most 200 field plans');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each field plan must be an object');
    const field = item as Record<string, unknown>;
    if (typeof field.key !== 'string' || !field.key.trim() || field.key.length > 160 || typeof field.label !== 'string' || field.label.length > 300 || typeof field.required !== 'boolean' || typeof field.resolved !== 'boolean' || !['standard', 'sensitive', 'voluntary-self-identification'].includes(field.classification as string) || !['exact', 'inferred', 'unknown'].includes(field.confidence as string)) throw new Error('Field plan is invalid');
    if ('value' in field || 'rawValue' in field) throw new Error('Raw field values must not be persisted');
    const valueRef = field.valueRef;
    if (valueRef !== undefined && (!valueRef || typeof valueRef !== 'object' || Array.isArray(valueRef) || !['profile', 'reusable-answer', 'document', 'user'].includes((valueRef as Record<string, unknown>).source as string) || typeof (valueRef as Record<string, unknown>).key !== 'string')) throw new Error('Field value references are invalid');
    if (field.maskedPreview !== undefined && (typeof field.maskedPreview !== 'string' || field.maskedPreview.length > 200)) throw new Error('Field previews must be short masked strings');
    return {
      key: field.key,
      label: field.label,
      required: field.required,
      resolved: field.resolved,
      classification: field.classification as ApplicationFieldDraft['classification'],
      confidence: field.confidence as ApplicationFieldDraft['confidence'],
      ...(valueRef ? { valueRef: valueRef as ApplicationFieldDraft['valueRef'] } : {}),
      ...(typeof field.maskedPreview === 'string' ? { maskedPreview: field.maskedPreview } : {}),
    };
  });
}

function parseSessionEvent(value: unknown, userControlled: boolean): ApplicationSessionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('event is required');
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'start': case 'cancel': return { type: event.type };
    case 'fill-completed': case 'answers-updated': return { type: event.type, fields: parseFields(event.fields) };
    case 'verification-required':
      if (!['captcha', 'mfa', 'email', 'identity', 'portal-login', 'other'].includes(event.reason as string)) throw new Error('Verification reason is invalid');
      return { type: 'verification-required', reason: event.reason as Extract<ApplicationSessionEvent, { type: 'verification-required' }>['reason'] };
    case 'fail':
      if (typeof event.message !== 'string' || !event.message.trim()) throw new Error('Failure message is required');
      return { type: 'fail', message: event.message };
    case 'review-approved':
      if (!userControlled) throw new Error('Review approval requires the signed-in user');
      return { type: 'review-approved', actor: 'user' };
    case 'verification-completed':
      if (!userControlled) throw new Error('Verification completion requires the signed-in user');
      return { type: 'verification-completed', actor: 'user' };
    case 'submission-confirmed':
      if (!userControlled) throw new Error('Submission confirmation requires the signed-in user');
      return { type: 'submission-confirmed', actor: 'user' };
    default: throw new Error('Application session event is not supported');
  }
}

function bearerFrom(event: ApiEvent) {
  const value = event.headers?.authorization ?? event.headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

function matchesHash(value: string, hash: string) {
  const left = Buffer.from(hashSecret(value)); const right = Buffer.from(hash);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function applySessionEvent(
  users: UserStore,
  session: ApplicationSession,
  body: Record<string, unknown>,
  timestamp: string,
  userControlled: boolean,
): Promise<{ statusCode: number; body: unknown }> {
  if (typeof body.eventId !== 'string' || !body.eventId.trim() || body.eventId.length > 160) throw new Error('eventId is required');
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) throw new Error('expectedVersion must be a non-negative integer');
  if (session.eventIds.includes(body.eventId)) return { statusCode: 200, body: { session: safeSession(session), replayed: true } };
  if (body.expectedVersion !== session.version) return { statusCode: 409, body: { message: 'Session version conflict', currentVersion: session.version } };
  if (!isBefore(timestamp, session.expiresAt)) return { statusCode: 410, body: { message: 'Application session expired' } };
  const event = parseSessionEvent(body.event, userControlled);
  const transitioned = transitionApplicationSession(session, event, timestamp);
  const updated: ApplicationSession = {
    ...transitioned,
    version: session.version + 1,
    eventIds: [...session.eventIds, body.eventId].slice(-100),
  };
  if (!await users.putApplicationSession(session.userId, updated, session.version)) return { statusCode: 409, body: { message: 'Session version conflict' } };
  if (updated.status === 'submitted') {
    const application = await users.getApplication(session.userId, session.applicationId);
    if (application && application.status === 'saved') {
      await users.putApplication(session.userId, { ...application, status: 'applied', updatedAt: timestamp });
    }
  }
  return { statusCode: 200, body: { session: safeSession(updated) } };
}

function pushPreferences(value: unknown): UserPreferences['push'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('push must be an object');
  const push = value as Record<string, unknown>; const template = (name: 'titleTemplate' | 'descriptionTemplate') => {
    const result = push[name]; if (result === undefined) return undefined;
    if (typeof result !== 'string' || result.length > 500) throw new Error(`push.${name} must be a string of at most 500 characters`);
    return result;
  };
  const titleTemplate = template('titleTemplate'); const descriptionTemplate = template('descriptionTemplate'); const aliases = push.roleAbbreviations;
  if (aliases !== undefined && (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.entries(aliases).some(([key, item]) => !key.trim() || typeof item !== 'string' || item.length > 40))) throw new Error('push.roleAbbreviations must map non-empty strings to short strings');
  return { ...(titleTemplate !== undefined ? { titleTemplate } : {}), ...(descriptionTemplate !== undefined ? { descriptionTemplate } : {}), ...(aliases ? { roleAbbreviations: aliases as Record<string, string> } : {}) };
}

function alertSettings(
  value: unknown,
  previous?: UserPreferences['alertSettings'],
): NonNullable<UserPreferences['alertSettings']> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('alertSettings must be an object');
  }
  const settings = (value ?? {}) as Record<string, unknown>;
  const delivery = settings.delivery ?? previous?.delivery ?? 'immediate';
  if (delivery !== 'immediate' && delivery !== 'daily-digest') {
    throw new Error('alertSettings.delivery must be immediate or daily-digest');
  }
  const reminders = settings.applicationReminders ?? previous?.applicationReminders ?? true;
  if (typeof reminders !== 'boolean') throw new Error('alertSettings.applicationReminders must be a boolean');
  const followUpDays = settings.followUpDays ?? previous?.followUpDays ?? 7;
  if (typeof followUpDays !== 'number' || !Number.isInteger(followUpDays) || followUpDays < 1 || followUpDays > 30) {
    throw new Error('alertSettings.followUpDays must be a whole number from 1 to 30');
  }
  const quietHours = settings.quietHours ?? previous?.quietHours;
  if (quietHours !== undefined) {
    if (!quietHours || typeof quietHours !== 'object' || Array.isArray(quietHours)) {
      throw new Error('alertSettings.quietHours must be an object');
    }
    const quiet = quietHours as Record<string, unknown>;
    if (
      typeof quiet.start !== 'string' ||
      typeof quiet.end !== 'string' ||
      typeof quiet.timezone !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end) ||
      !quiet.timezone.trim() ||
      quiet.timezone.length > 100
    ) {
      throw new Error('alertSettings.quietHours needs start/end times (HH:MM) and a timezone');
    }
  }
  return {
    delivery,
    applicationReminders: reminders,
    followUpDays,
    ...(quietHours ? { quietHours: quietHours as { start: string; end: string; timezone: string } } : {}),
  };
}

function requireProfile(value: Record<string, unknown>, userId: string): ApplicantProfile {
  const contact = value.contact as ApplicantProfile['contact'];
  if (!contact?.name || !contact.email || typeof value.location !== 'string' || typeof value.workAuthorization !== 'string' || !Array.isArray(value.education) || !value.links || !value.reusableAnswers || typeof value.resumeDocumentId !== 'string') throw new Error('Profile needs contact name/email, location, work authorization, résumé, education, links, and reusable answers');
  if ((contact.firstName !== undefined && typeof contact.firstName !== 'string') || (contact.lastName !== undefined && typeof contact.lastName !== 'string') || (contact.phone !== undefined && typeof contact.phone !== 'string')) throw new Error('Profile contact details must be text');
  return { userId, contact, location: value.location, workAuthorization: value.workAuthorization, links: value.links as Record<string, string>, education: value.education as ApplicantProfile['education'], reusableAnswers: value.reusableAnswers as Record<string, string>, ...(typeof value.resumeDocumentId === 'string' ? { resumeDocumentId: value.resumeDocumentId } : {}), ...(value.sensitive && typeof value.sensitive === 'object' ? { sensitive: value.sensitive as Record<string, unknown> } : {}), updatedAt: now() };
}

export interface ApiDependencies { jobs: InternshipStore; users: UserStore; documentsBucket?: string; userPoolId?: string; integrations?: EmployerIntegrationRegistry; s3?: S3Client; cognito?: CognitoIdentityProviderClient; now?: () => string; }
export function createApiHandler(dependencies: ApiDependencies) {
  const integrations = dependencies.integrations ?? new EmployerIntegrationRegistry(); const s3 = dependencies.s3 ?? new S3Client({});
  return async (event: ApiEvent): Promise<ApiResponse> => {
    try {
      const method = event.requestContext?.http?.method ?? event.routeKey?.split(' ')[0] ?? 'GET'; const path = event.rawPath ?? event.routeKey?.split(' ')[1] ?? '/';
      if (method === 'OPTIONS') return reply(204, {});
      if (method === 'GET' && path === '/jobs') {
        const requestedLimit = Number(event.queryStringParameters?.limit ?? 25);
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50) : 25;
        const status = event.queryStringParameters?.status ?? 'open';
        if (status !== 'open' && status !== 'closed') return reply(400, { message: 'status must be open or closed' });
        const page = await dependencies.jobs.listOpen?.(event.queryStringParameters?.cursor, limit, status);
        return reply(200, page ?? { jobs: [] });
      }
      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) {
        const job = await dependencies.jobs.getJob?.(decodeURIComponent(jobMatch[1]));
        return job ? reply(200, { ...job, assistance: assistanceAvailability(job) }) : reply(404, { message: 'Job not found' });
      }
      if (method === 'POST' && path === '/assist/exchange') {
        const body = parseBody(event);
        if (typeof body.sessionId !== 'string' || typeof body.code !== 'string') return reply(400, { message: 'sessionId and code are required' });
        const session = await dependencies.users.getApplicationSessionById(body.sessionId);
        const timestamp = dependencies.now?.() ?? now();
        if (!session?.handoff || session.handoff.consumedAt || !isBefore(timestamp, session.handoff.codeExpiresAt) || !matchesHash(body.code, session.handoff.codeHash)) return reply(401, { message: 'Handoff code is invalid or expired' });
        const bearer = `${session.sessionId}.${randomBytes(32).toString('base64url')}`;
        const bearerExpiresAt = inMinutes(timestamp, 5);
        const updated: ApplicationSession = {
          ...session,
          version: session.version + 1,
          updatedAt: timestamp,
          handoff: { ...session.handoff, consumedAt: timestamp, bearerHash: hashSecret(bearer), bearerExpiresAt },
        };
        if (!await dependencies.users.putApplicationSession(session.userId, updated, session.version)) return reply(409, { message: 'Session changed; retry the exchange' });
        return reply(200, { bearer, expiresAt: bearerExpiresAt, session: safeSession(updated) });
      }
      if ((method === 'GET' && path === '/assist/session') || (method === 'POST' && path === '/assist/session/events')) {
        const bearer = bearerFrom(event);
        const [sessionId] = bearer?.split('.', 2) ?? [];
        if (!bearer || !sessionId) return reply(401, { message: 'A session bearer is required' });
        const session = await dependencies.users.getApplicationSessionById(sessionId);
        const timestamp = dependencies.now?.() ?? now();
        if (!session?.handoff?.bearerHash || !session.handoff.bearerExpiresAt || !isBefore(timestamp, session.handoff.bearerExpiresAt) || !matchesHash(bearer, session.handoff.bearerHash)) return reply(401, { message: 'Session bearer is invalid or expired' });
        if (method === 'GET') return reply(200, { session: safeSession(session) });
        const body = parseBody(event);
        const result = await applySessionEvent(dependencies.users, session, body, timestamp, false);
        return reply(result.statusCode, result.body);
      }
      const userId = identity(event); if (!userId) return reply(401, { message: 'Authentication required' });
      if (method === 'GET' && path === '/me/preferences') return reply(200, (await dependencies.users.getPreferences(userId)) ?? { userId, filter: {}, alertsEnabled: false, onboardingComplete: false });
      if (method === 'PUT' && path === '/me/preferences') { const body = parseBody(event); const previous = await dependencies.users.getPreferences(userId); const filter = parseJobFilter(body.filter ?? previous?.filter ?? {}); const push = pushPreferences(body.push); const value: UserPreferences = { userId, filter: filter ?? {}, alertsEnabled: typeof body.alertsEnabled === 'boolean' ? body.alertsEnabled : previous?.alertsEnabled ?? false, onboardingComplete: typeof body.onboardingComplete === 'boolean' ? body.onboardingComplete : previous?.onboardingComplete ?? false, alertSettings: alertSettings(body.alertSettings, previous?.alertSettings), ...(push !== undefined ? { push } : previous?.push ? { push: previous.push } : {}), ...(previous?.lastCatalogOpenedAt ? { lastCatalogOpenedAt: previous.lastCatalogOpenedAt } : {}), updatedAt: now() }; await dependencies.users.putPreferences(value); return reply(200, value); }
      if (method === 'POST' && path === '/me/opening') {
        const openedAt = dependencies.now?.() ?? now();
        const previous = await dependencies.users.getPreferences(userId);
        const previousOpenedAt = previous?.lastCatalogOpenedAt;
        const preferences: UserPreferences = {
          userId,
          filter: previous?.filter ?? {},
          alertsEnabled: previous?.alertsEnabled ?? false,
          onboardingComplete: previous?.onboardingComplete ?? false,
          ...(previous?.alertSettings ? { alertSettings: previous.alertSettings } : {}),
          ...(previous?.push ? { push: previous.push } : {}),
          lastCatalogOpenedAt: openedAt,
          // Opening the catalog is not a preference edit, so preserve the
          // existing preference timestamp when one exists.
          updatedAt: previous?.updatedAt ?? openedAt,
        };
        // The first launch establishes a baseline. This avoids presenting an
        // unbounded historical backlog when the feature rolls out.
        if (!previousOpenedAt) {
          await dependencies.users.putPreferences(preferences);
          return reply(200, { jobs: [], total: 0, hasMore: false, previousOpenedAt: null, openedAt });
        }
        const matches = (await dependencies.jobs.listOpenSince(previousOpenedAt, openedAt))
          .filter((job) => matchesJobFilter(job, previous?.filter));
        // Keep launch fast if a source backfills many records; the Feed remains
        // the complete catalog and provides the explicit path to the remainder.
        const limit = 50;
        await dependencies.users.putPreferences(preferences);
        return reply(200, { jobs: matches.slice(0, limit), total: matches.length, hasMore: matches.length > limit, previousOpenedAt, openedAt });
      }
      if (method === 'POST' && path === '/me/devices') { const body = parseBody(event); if (typeof body.token !== 'string' || !body.token.startsWith('ExponentPushToken[') || (body.platform !== 'ios' && body.platform !== 'android')) return reply(400, { message: 'A valid Expo token and platform are required' }); const value: DeviceToken = { userId, token: body.token, platform: body.platform, active: true, createdAt: now(), updatedAt: now() }; await dependencies.users.putDevice(value); return reply(201, value); }
      if (method === 'DELETE' && path.startsWith('/me/devices/')) { await dependencies.users.deleteDevice(userId, decodeURIComponent(path.slice('/me/devices/'.length))); return reply(204, {}); }
      if (method === 'GET' && path === '/me/profile') return reply(200, (await dependencies.users.getProfile(userId)) ?? null);
      if (method === 'PUT' && path === '/me/profile') { const profile = requireProfile(parseBody(event), userId); await dependencies.users.putProfile(profile); return reply(200, profile); }
      if (method === 'GET' && path === '/me/applications') {
        const requestedStatus = event.queryStringParameters?.status;
        if (requestedStatus !== undefined && !statuses.includes(requestedStatus as ApplicationStatus)) return reply(400, { message: `status must be one of ${statuses.join(', ')}` });
        const applications = (await dependencies.users.listApplications(userId)).filter((application) => !requestedStatus || application.status === requestedStatus);
        const summaries = await Promise.all(applications.map(async (application) => applicationSummary(application, await dependencies.jobs.getJob?.(application.jobId))));
        return reply(200, { applications: summaries });
      }
      if (method === 'POST' && path === '/me/applications') { const body = parseBody(event); if (typeof body.jobId !== 'string') return reply(400, { message: 'jobId is required' }); const job = await dependencies.jobs.getJob?.(body.jobId); if (!job) return reply(404, { message: 'Job not found' }); const timestamp = now(); const existing = (await dependencies.users.listApplications(userId)).find((application) => application.jobId === job.jobId); const application: ApplicationRecord = { applicationId: existing?.applicationId ?? randomUUID(), jobId: job.jobId, status: statuses.includes(body.status as ApplicationStatus) ? body.status as ApplicationStatus : existing?.status ?? 'saved', notes: typeof body.notes === 'string' ? body.notes.slice(0, 5000) : existing?.notes, applyMode: integrations.applyMode(job), createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }; await dependencies.users.putApplication(userId, application); return reply(existing ? 200 : 201, { ...application, officialApplyUrl: application.applyMode === 'official-form' ? job.applyUrl : undefined }); }
      const appMatch = path.match(/^\/me\/applications\/([^/]+)$/);
      if (method === 'PATCH' && appMatch) { const current = await dependencies.users.getApplication(userId, decodeURIComponent(appMatch[1])); if (!current) return reply(404, { message: 'Application not found' }); const body = parseBody(event); if (body.status !== undefined && !statuses.includes(body.status as ApplicationStatus)) return reply(400, { message: `status must be one of ${statuses.join(', ')}` }); const updated: ApplicationRecord = { ...current, ...(body.status ? { status: body.status as ApplicationStatus } : {}), ...(typeof body.notes === 'string' ? { notes: body.notes.slice(0, 5000) } : {}), updatedAt: now() }; await dependencies.users.putApplication(userId, updated); return reply(200, updated); }
      const applicationSessionMatch = path.match(/^\/me\/applications\/([^/]+)\/assistance-sessions$/);
      if (method === 'POST' && applicationSessionMatch) {
        const application = await dependencies.users.getApplication(userId, decodeURIComponent(applicationSessionMatch[1]));
        if (!application) return reply(404, { message: 'Application not found' });
        if (application.status !== 'saved') return reply(409, { message: 'Only To Apply roles can start assistance' });
        const job = await dependencies.jobs.getJob?.(application.jobId);
        if (!job) return reply(404, { message: 'Job not found' });
        const body = parseBody(event);
        if (body.mode !== 'headed' && body.mode !== 'headless') return reply(400, { message: 'mode must be headed or headless' });
        const availability = assistanceAvailability(job, application.applyMode);
        if ((body.mode === 'headed' && availability.eligibility !== 'headed-supported') || (body.mode === 'headless' && availability.eligibility !== 'remote-supported')) {
          return reply(409, { message: 'Assistance is not available for this destination', assistance: availability });
        }
        const timestamp = dependencies.now?.() ?? now();
        const session = createApplicationSession({ sessionId: randomUUID(), userId, applicationId: application.applicationId, jobId: job.jobId, mode: body.mode, now: timestamp });
        const code = `${session.sessionId}.${randomBytes(32).toString('base64url')}`;
        session.handoff = { codeHash: hashSecret(code), codeExpiresAt: inMinutes(timestamp, 1) };
        if (!await dependencies.users.putApplicationSession(userId, session)) return reply(409, { message: 'Could not create application session; retry' });
        return reply(201, { session: safeSession(session), handoff: { sessionId: session.sessionId, code, expiresAt: inMinutes(timestamp, 1) } });
      }
      const sessionMatch = path.match(/^\/me\/application-sessions\/([^/]+)$/);
      if (method === 'GET' && sessionMatch) {
        const session = await dependencies.users.getApplicationSession(userId, decodeURIComponent(sessionMatch[1]));
        return session ? reply(200, { session: safeSession(session) }) : reply(404, { message: 'Application session not found' });
      }
      const sessionEventsMatch = path.match(/^\/me\/application-sessions\/([^/]+)\/events$/);
      if (method === 'POST' && sessionEventsMatch) {
        const session = await dependencies.users.getApplicationSession(userId, decodeURIComponent(sessionEventsMatch[1]));
        if (!session) return reply(404, { message: 'Application session not found' });
        const result = await applySessionEvent(dependencies.users, session, parseBody(event), dependencies.now?.() ?? now(), true);
        return reply(result.statusCode, result.body);
      }
      const sessionCancelMatch = path.match(/^\/me\/application-sessions\/([^/]+)\/cancel$/);
      if (method === 'POST' && sessionCancelMatch) {
        const session = await dependencies.users.getApplicationSession(userId, decodeURIComponent(sessionCancelMatch[1]));
        if (!session) return reply(404, { message: 'Application session not found' });
        const body = parseBody(event);
        const result = await applySessionEvent(dependencies.users, session, { ...body, event: { type: 'cancel' } }, dependencies.now?.() ?? now(), true);
        return reply(result.statusCode, result.body);
      }
      if (method === 'GET' && path === '/me/documents') return reply(200, { documents: await dependencies.users.listDocuments(userId) });
      if (method === 'POST' && path === '/me/documents') { if (!dependencies.documentsBucket) return reply(503, { message: 'Document storage is unavailable' }); const body = parseBody(event); if (typeof body.fileName !== 'string' || typeof body.contentType !== 'string') return reply(400, { message: 'fileName and contentType are required' }); const documentId = randomUUID(); const objectKey = `private/${userId}/${documentId}`; const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: dependencies.documentsBucket, Key: objectKey, ContentType: body.contentType, ServerSideEncryption: 'aws:kms' }), { expiresIn: 300 }); const document = { userId, documentId, fileName: body.fileName.slice(0, 255), contentType: body.contentType, objectKey, createdAt: now() }; await dependencies.users.putDocument(document); return reply(201, { document, uploadUrl }); }
      const docMatch = path.match(/^\/me\/documents\/([^/]+)$/);
      if (method === 'GET' && docMatch) { if (!dependencies.documentsBucket) return reply(503, { message: 'Document storage is unavailable' }); const document = (await dependencies.users.listDocuments(userId)).find((item) => item.documentId === decodeURIComponent(docMatch[1])); if (!document) return reply(404, { message: 'Document not found' }); return reply(200, { document, downloadUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey }), { expiresIn: 300 }) }); }
      if (method === 'DELETE' && docMatch) { const document = (await dependencies.users.listDocuments(userId)).find((item) => item.documentId === decodeURIComponent(docMatch[1])); if (!document) return reply(404, { message: 'Document not found' }); if (dependencies.documentsBucket) await s3.send(new DeleteObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey })); await dependencies.users.deleteDocument(userId, document.documentId); return reply(204, {}); }
      if (method === 'DELETE' && path === '/me') { const documents = await dependencies.users.deleteUser(userId); if (dependencies.documentsBucket) await Promise.all(documents.map((document) => s3.send(new DeleteObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey })))); if (dependencies.userPoolId) await (dependencies.cognito ?? new CognitoIdentityProviderClient({})).send(new AdminDeleteUserCommand({ UserPoolId: dependencies.userPoolId, Username: userId })); return reply(204, {}); }
      return reply(404, { message: 'Not found', supportedCategories: jobCategories });
    } catch (error) { return reply(400, { message: error instanceof Error ? error.message : 'Invalid request' }); }
  };
}

export const handler = createApiHandler({ jobs: new DynamoInternshipStore(process.env.INTERNSHIPS_TABLE ?? ''), users: new DynamoUserStore(process.env.USERS_TABLE ?? ''), documentsBucket: process.env.DOCUMENTS_BUCKET, userPoolId: process.env.USER_POOL_ID });
