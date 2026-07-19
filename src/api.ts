import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { jobCategories, parseJobFilter } from './core/filters.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import type { ApplicantProfile, ApplicationRecord, ApplicationStatus, DeviceToken, UserPreferences } from './types.js';
import { EmployerIntegrationRegistry } from './providers.js';

type ApiEvent = { requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } }; http?: { method?: string }; requestId?: string }; rawPath?: string; routeKey?: string; pathParameters?: Record<string, string>; queryStringParameters?: Record<string, string>; body?: string | null };
type ApiResponse = { statusCode: number; headers: Record<string, string>; body: string };
const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
const reply = (statusCode: number, body: unknown): ApiResponse => ({ statusCode, headers, body: JSON.stringify(body) });
const parseBody = (event: ApiEvent): Record<string, unknown> => { try { return event.body ? JSON.parse(event.body) as Record<string, unknown> : {}; } catch { throw new Error('Request body must be valid JSON'); } };
const identity = (event: ApiEvent) => event.requestContext?.authorizer?.jwt?.claims?.sub;
const now = () => new Date().toISOString();
const statuses: ApplicationStatus[] = ['saved', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn'];

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

function requireProfile(value: Record<string, unknown>, userId: string): ApplicantProfile {
  const contact = value.contact as ApplicantProfile['contact'];
  if (!contact?.name || !contact.email || typeof value.location !== 'string' || typeof value.workAuthorization !== 'string' || !Array.isArray(value.education) || !value.links || !value.reusableAnswers || typeof value.resumeDocumentId !== 'string') throw new Error('Profile needs contact name/email, location, work authorization, résumé, education, links, and reusable answers');
  return { userId, contact, location: value.location, workAuthorization: value.workAuthorization, links: value.links as Record<string, string>, education: value.education as ApplicantProfile['education'], reusableAnswers: value.reusableAnswers as Record<string, string>, ...(typeof value.resumeDocumentId === 'string' ? { resumeDocumentId: value.resumeDocumentId } : {}), ...(value.sensitive && typeof value.sensitive === 'object' ? { sensitive: value.sensitive as Record<string, unknown> } : {}), updatedAt: now() };
}

export interface ApiDependencies { jobs: InternshipStore; users: UserStore; documentsBucket?: string; userPoolId?: string; integrations?: EmployerIntegrationRegistry; s3?: S3Client; cognito?: CognitoIdentityProviderClient; }
export function createApiHandler(dependencies: ApiDependencies) {
  const integrations = dependencies.integrations ?? new EmployerIntegrationRegistry(); const s3 = dependencies.s3 ?? new S3Client({});
  return async (event: ApiEvent): Promise<ApiResponse> => {
    try {
      const method = event.requestContext?.http?.method ?? event.routeKey?.split(' ')[0] ?? 'GET'; const path = event.rawPath ?? event.routeKey?.split(' ')[1] ?? '/';
      if (method === 'OPTIONS') return reply(204, {});
      if (method === 'GET' && path === '/jobs') {
        const page = await dependencies.jobs.listOpen?.(event.queryStringParameters?.cursor, Math.min(Math.max(Number(event.queryStringParameters?.limit ?? 25), 1), 50));
        return reply(200, page ?? { jobs: [] });
      }
      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) { const job = await dependencies.jobs.getJob?.(decodeURIComponent(jobMatch[1])); return job ? reply(200, job) : reply(404, { message: 'Job not found' }); }
      const userId = identity(event); if (!userId) return reply(401, { message: 'Authentication required' });
      if (method === 'GET' && path === '/me/preferences') return reply(200, (await dependencies.users.getPreferences(userId)) ?? { userId, filter: {}, alertsEnabled: false, onboardingComplete: false });
      if (method === 'PUT' && path === '/me/preferences') { const body = parseBody(event); const previous = await dependencies.users.getPreferences(userId); const filter = parseJobFilter(body.filter ?? previous?.filter ?? {}); const push = pushPreferences(body.push); const value: UserPreferences = { userId, filter: filter ?? {}, alertsEnabled: typeof body.alertsEnabled === 'boolean' ? body.alertsEnabled : previous?.alertsEnabled ?? false, onboardingComplete: typeof body.onboardingComplete === 'boolean' ? body.onboardingComplete : previous?.onboardingComplete ?? false, ...(push !== undefined ? { push } : previous?.push ? { push: previous.push } : {}), updatedAt: now() }; await dependencies.users.putPreferences(value); return reply(200, value); }
      if (method === 'POST' && path === '/me/devices') { const body = parseBody(event); if (typeof body.token !== 'string' || !body.token.startsWith('ExponentPushToken[') || (body.platform !== 'ios' && body.platform !== 'android')) return reply(400, { message: 'A valid Expo token and platform are required' }); const value: DeviceToken = { userId, token: body.token, platform: body.platform, active: true, createdAt: now(), updatedAt: now() }; await dependencies.users.putDevice(value); return reply(201, value); }
      if (method === 'DELETE' && path.startsWith('/me/devices/')) { await dependencies.users.deleteDevice(userId, decodeURIComponent(path.slice('/me/devices/'.length))); return reply(204, {}); }
      if (method === 'GET' && path === '/me/profile') return reply(200, (await dependencies.users.getProfile(userId)) ?? null);
      if (method === 'PUT' && path === '/me/profile') { const profile = requireProfile(parseBody(event), userId); await dependencies.users.putProfile(profile); return reply(200, profile); }
      if (method === 'GET' && path === '/me/applications') return reply(200, { applications: await dependencies.users.listApplications(userId) });
      if (method === 'POST' && path === '/me/applications') { const body = parseBody(event); if (typeof body.jobId !== 'string') return reply(400, { message: 'jobId is required' }); const job = await dependencies.jobs.getJob?.(body.jobId); if (!job) return reply(404, { message: 'Job not found' }); const timestamp = now(); const existing = (await dependencies.users.listApplications(userId)).find((application) => application.jobId === job.jobId); const application: ApplicationRecord = { applicationId: existing?.applicationId ?? randomUUID(), jobId: job.jobId, status: statuses.includes(body.status as ApplicationStatus) ? body.status as ApplicationStatus : existing?.status ?? 'saved', notes: typeof body.notes === 'string' ? body.notes.slice(0, 5000) : existing?.notes, applyMode: integrations.applyMode(job), createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }; await dependencies.users.putApplication(userId, application); return reply(existing ? 200 : 201, { ...application, officialApplyUrl: application.applyMode === 'official-form' ? job.applyUrl : undefined }); }
      const appMatch = path.match(/^\/me\/applications\/([^/]+)$/);
      if (method === 'PATCH' && appMatch) { const current = await dependencies.users.getApplication(userId, decodeURIComponent(appMatch[1])); if (!current) return reply(404, { message: 'Application not found' }); const body = parseBody(event); if (body.status !== undefined && !statuses.includes(body.status as ApplicationStatus)) return reply(400, { message: `status must be one of ${statuses.join(', ')}` }); const updated: ApplicationRecord = { ...current, ...(body.status ? { status: body.status as ApplicationStatus } : {}), ...(typeof body.notes === 'string' ? { notes: body.notes.slice(0, 5000) } : {}), updatedAt: now() }; await dependencies.users.putApplication(userId, updated); return reply(200, updated); }
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
