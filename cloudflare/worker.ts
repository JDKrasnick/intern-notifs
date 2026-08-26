import { createApiHandler, type DocumentStorage } from '../src/api.js';
import { ashbyWorkMessages, isAshbySourceDue } from '../src/ashby-dispatch.js';
import { processAshbyQueue } from '../src/ashby-worker.js';
import { greenhouseWorkMessages, isGreenhouseSourceDue } from '../src/greenhouse-dispatch.js';
import { processGreenhouseQueue } from '../src/greenhouse-worker.js';
import { isLeverSourceDue, leverWorkMessages } from '../src/lever-dispatch.js';
import { processLeverQueue } from '../src/lever-worker.js';
import { drainPendingExpoNotifications, ExpoPushPublisher, type EmailSender } from '../src/notifications.js';
import { runRuntimeCommand } from '../src/runtime.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import { createSourceOperationsHandler } from '../src/greenhouse-operations-api.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';
import { defaultSources } from '../src/sources/index.js';
import type { SourceCheckpoint, SourceHealth } from '../src/types.js';
import { authenticatedInstallation, authenticatedUser, cleanupExpiredAuth, consumeAuthRateLimit, createInstallation, deleteAuthUser, handleAuthRequest, type AuthEnvironment } from './auth.js';
import { runCatalogQualityBackfill } from '../src/catalog-quality-backfill.js';
import { D1InternshipStore, D1ReleaseStore, D1UserStore } from './d1-store.js';
import { queueHasBacklog } from './queue-backlog.js';
import type { MessageBatch, Queue, R2Bucket, ScheduledController } from './types.js';

export interface Environment extends AuthEnvironment {
  DOCUMENTS: R2Bucket;
  GREENHOUSE_QUEUE: Queue;
  LEVER_QUEUE: Queue;
  ASHBY_QUEUE: Queue;
  GITHUB_QUEUE: Queue;
  GREENHOUSE_DLQ: Queue;
  LEVER_DLQ: Queue;
  ASHBY_DLQ: Queue;
  PUBLIC_API_URL: string;
  RESEND_API_KEY?: string;
  AUTH_FROM_EMAIL?: string;
  DIGEST_TO_EMAIL?: string;
  NTFY_TOPIC?: string;
  NTFY_ENDPOINT?: string;
  OPERATIONS_SHARED_SECRET: string;
  BILLING_WEBHOOK_SECRET?: string;
  CLOUDFLARE_SHUTDOWN_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  WORKER_NAME: string;
  GREENHOUSE_QUEUE_ID: string;
  LEVER_QUEUE_ID: string;
  ASHBY_QUEUE_ID: string;
  GITHUB_QUEUE_ID: string;
}

type OperationsQueueEnvironment = Pick<Environment,
  'GREENHOUSE_QUEUE' | 'LEVER_QUEUE' | 'ASHBY_QUEUE' | 'GREENHOUSE_DLQ' | 'LEVER_DLQ' | 'ASHBY_DLQ'>;

const maxDocumentBytes = 5 * 1024 * 1024;

export function cloudflareOperationsQueueClient(env: OperationsQueueEnvironment) {
  const queues: Record<string, Queue> = {
    greenhouse: env.GREENHOUSE_QUEUE,
    lever: env.LEVER_QUEUE,
    ashby: env.ASHBY_QUEUE,
    'greenhouse-dlq': env.GREENHOUSE_DLQ,
    'lever-dlq': env.LEVER_DLQ,
    'ashby-dlq': env.ASHBY_DLQ,
  };
  return {
    async send(command: { input?: { QueueUrl?: string; MessageBody?: string } }) {
      const input = command.input;
      const queue = input?.QueueUrl ? queues[input.QueueUrl] : undefined;
      if (!queue) throw new Error(`Cloudflare queue ${JSON.stringify(input?.QueueUrl)} is not configured`);
      if (input?.MessageBody) {
        await queue.send(JSON.parse(input.MessageBody));
        return {};
      }
      if (!queue.metrics) throw new Error(`Cloudflare queue metrics are unavailable for ${input?.QueueUrl}`);
      const metrics = await queue.metrics();
      return {
        Attributes: {
          // Cloudflare exposes one real-time backlog total rather than SQS's
          // visible/in-flight split. The operations response marks processing
          // telemetry unavailable instead of fabricating that split.
          ApproximateNumberOfMessages: String(metrics.backlogCount),
        },
      };
    },
  };
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Operations-Key,X-Operations-Actor',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function eventResponse(result: { body: string; statusCode: number; headers?: Record<string, string> }): Response {
  const body = [101, 204, 205, 304].includes(result.statusCode) ? null : result.body;
  return withCors(new Response(body, { status: result.statusCode, headers: result.headers }));
}

function operationsAuthorized(request: Request, env: Environment): boolean {
  return Boolean(env.OPERATIONS_SHARED_SECRET)
    && request.headers.get('X-Operations-Key') === env.OPERATIONS_SHARED_SECRET;
}

function apiEvent(request: Request, userId: string | undefined, body: string | null) {
  const url = new URL(request.url);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  return {
    requestContext: {
      http: { method: request.method },
      ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}),
    },
    rawPath: url.pathname,
    queryStringParameters,
    headers: Object.fromEntries(request.headers.entries()),
    body,
  };
}

async function isShutdown(env: Environment): Promise<boolean> {
  const state = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'billing_shutdown'").first<{ value: string }>();
  return state?.value === 'stopped';
}

async function cloudflareApi(env: Environment, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!env.CLOUDFLARE_SHUTDOWN_TOKEN) throw new Error('Cloudflare shutdown token is not configured');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_SHUTDOWN_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const result = await response.json() as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
  if (!response.ok || result.success === false) throw new Error(result.errors?.[0]?.message ?? `Cloudflare API returned HTTP ${response.status}`);
  return result.result;
}

async function billingShutdown(request: Request, env: Environment): Promise<Response> {
  if (request.method !== 'POST' || !env.BILLING_WEBHOOK_SECRET || request.headers.get('cf-webhook-auth') !== env.BILLING_WEBHOOK_SECRET) {
    return Response.json({ message: 'Not found' }, { status: 404 });
  }

  const queueIds = [env.GREENHOUSE_QUEUE_ID, env.LEVER_QUEUE_ID, env.ASHBY_QUEUE_ID, env.GITHUB_QUEUE_ID];
  const scriptPath = `/workers/scripts/${encodeURIComponent(env.WORKER_NAME)}`;
  if (new URL(request.url).searchParams.get('dry-run') === 'true') {
    await Promise.all([
      ...queueIds.map((queueId) => cloudflareApi(env, `/queues/${queueId}/consumers`)),
      cloudflareApi(env, `${scriptPath}/schedules`),
      cloudflareApi(env, `${scriptPath}/subdomain`),
    ]);
    return Response.json({ ready: true });
  }

  const payload = await request.json().catch(() => null) as { account_id?: string; alert_type?: string; policy_name?: string } | null;
  if (payload?.account_id !== env.CLOUDFLARE_ACCOUNT_ID
    || payload.alert_type !== 'billing_budget_alert'
    || payload.policy_name !== 'InternNotifs budget warning: $5') {
    return Response.json({ ignored: true });
  }

  await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES ('billing_shutdown', 'stopped', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(new Date().toISOString()).run();

  for (const queueId of queueIds) {
    const consumers = await cloudflareApi(env, `/queues/${queueId}/consumers`) as Array<{ consumer_id?: string }>;
    for (const consumer of consumers) {
      if (consumer.consumer_id) await cloudflareApi(env, `/queues/${queueId}/consumers/${consumer.consumer_id}`, { method: 'DELETE' });
    }
  }
  await cloudflareApi(env, `${scriptPath}/schedules`, { method: 'PUT', body: '[]' });
  await cloudflareApi(env, `${scriptPath}/subdomain`, { method: 'DELETE' });
  return Response.json({ stopped: true });
}

class ResendEmailSender implements EmailSender {
  constructor(private readonly from: string, private readonly to: string, private readonly apiKey: string) {}
  async send(subject: string, text: string, html: string): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [this.to], subject, text, html }),
    });
    if (!response.ok) throw new Error(`Email provider rejected the digest with HTTP ${response.status}`);
  }
}

function documentStorage(env: Environment): DocumentStorage {
  const base = env.PUBLIC_API_URL.replace(/\/$/u, '');
  return {
    async createUploadUrl(document) { return `${base}/me/documents/${encodeURIComponent(document.documentId)}/content`; },
    async createDownloadUrl(document) { return `${base}/me/documents/${encodeURIComponent(document.documentId)}/content`; },
    async deleteObject(objectKey) { await env.DOCUMENTS.delete(objectKey); },
  };
}

export async function readDocumentUpload(request: Request): Promise<
  { tooLarge: true } | { tooLarge: false; content: ArrayBuffer }
> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxDocumentBytes) {
    await request.body?.cancel();
    return { tooLarge: true };
  }
  if (!request.body) return { tooLarge: false, content: new ArrayBuffer(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxDocumentBytes) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(result.value);
  }

  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, content: content.buffer };
}

export async function documentContent(request: Request, env: Environment, userId: string, documentId: string): Promise<Response> {
  const users = new D1UserStore(env.DB);
  const document = (await users.listDocuments(userId)).find((item) => item.documentId === documentId);
  if (!document) return Response.json({ message: 'Document not found' }, { status: 404 });
  if (request.method === 'PUT') {
    const upload = await readDocumentUpload(request);
    if (upload.tooLarge) return Response.json({ message: 'Documents must be 5 MiB or smaller' }, { status: 413 });
    const period = new Date().toISOString().slice(0, 7);
    if (!await users.claimDocumentUpload(period)) return Response.json({ message: 'Monthly document upload quota reached' }, { status: 429 });
    await env.DOCUMENTS.put(document.objectKey, upload.content, { httpMetadata: { contentType: document.contentType } });
    return new Response(null, { status: 204 });
  }
  const object = await env.DOCUMENTS.get(document.objectKey);
  if (!object) return Response.json({ message: 'Document content not found' }, { status: 404 });
  const headers = new Headers({ 'Content-Type': object.httpMetadata?.contentType ?? document.contentType, 'Cache-Control': 'private, no-store' });
  if (object.size !== undefined) headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

async function fetchHandler(request: Request, env: Environment): Promise<Response> {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
  const url = new URL(request.url);
  if (url.pathname === '/internal/billing-shutdown') return billingShutdown(request, env);
  if (await isShutdown(env)) return withCors(Response.json({ message: 'Service paused by billing guard' }, { status: 503 }));
  if (request.method === 'POST' && url.pathname === '/internal/refresh-catalog') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(Response.json(await refreshCatalogProjection(new D1InternshipStore(env.DB))));
  }
  if (request.method === 'POST' && url.pathname === '/internal/recover-notifications') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const body = await request.json().catch(() => null) as { since?: unknown; limit?: unknown; apply?: unknown; expectedCount?: unknown } | null;
    const since = typeof body?.since === 'string' ? body.since : '';
    const limit = body?.limit === undefined ? 100 : body.limit;
    const apply = body?.apply === true;
    if (!since || Number.isNaN(Date.parse(since)) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return withCors(Response.json({ message: 'since must be an ISO timestamp and limit must be an integer from 1 to 100' }, { status: 400 }));
    }
    if (apply && (typeof body?.expectedCount !== 'number' || !Number.isInteger(body.expectedCount) || body.expectedCount < 0)) {
      return withCors(Response.json({ message: 'expectedCount is required when apply is true' }, { status: 400 }));
    }
    try {
      const result = await new D1InternshipStore(env.DB).recoverUndeliveredNotifications({
        since: new Date(since).toISOString(), limit, apply,
        ...(typeof body?.expectedCount === 'number' ? { expectedCount: body.expectedCount } : {}),
      });
      return withCors(Response.json({ ...result, applied: apply }));
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Notification recovery failed' }, { status: 409 }));
    }
  }
  if (request.method === 'POST' && url.pathname === '/internal/catalog-quality-backfill') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const input = await request.json().catch(() => ({})) as { apply?: boolean; repairToken?: string; expectedChanged?: number };
    try {
      const report = await runCatalogQualityBackfill(env.DB, input);
      if (input.apply && report.projectionRefreshRequired) {
        await refreshCatalogProjection(new D1InternshipStore(env.DB));
        const verified = await runCatalogQualityBackfill(env.DB);
        return withCors(Response.json({ ...report, verification: verified }));
      }
      return withCors(Response.json(report, { status: report.conflicts.length ? 409 : 200 }));
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Backfill failed' }, { status: 409 }));
    }
  }
  if (request.method === 'POST' && url.pathname === '/internal/poll-source') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const provider = url.searchParams.get('provider');
    const sourceId = url.searchParams.get('sourceId');
    if (!sourceId || (provider !== 'greenhouse' && provider !== 'lever' && provider !== 'ashby')) {
      return withCors(Response.json({ message: 'provider and sourceId are required' }, { status: 400 }));
    }
    const registry = provider === 'greenhouse' ? reviewedGreenhouseSources : provider === 'lever' ? reviewedLeverSources : reviewedAshbySources;
    const source = registry.find((candidate) => candidate.id === sourceId);
    if (!source) return withCors(Response.json({ message: 'Source not found' }, { status: 404 }));
    const now = new Date();
    const message = provider === 'greenhouse'
      ? { ...greenhouseWorkMessages([source as typeof reviewedGreenhouseSources[number]], now)[0]!, force: true }
      : provider === 'lever'
        ? { ...leverWorkMessages([source as typeof reviewedLeverSources[number]], now, crypto.randomUUID())[0]!, force: true }
        : { ...ashbyWorkMessages([source as typeof reviewedAshbySources[number]], now, crypto.randomUUID())[0]!, force: true };
    const event = { Records: [{ messageId: crypto.randomUUID(), body: JSON.stringify(message) }] };
    const dependencies = { store: new D1InternshipStore(env.DB), userStore: new D1UserStore(env.DB) };
    const result = provider === 'greenhouse'
      ? await processGreenhouseQueue(event, dependencies)
      : provider === 'lever'
        ? await processLeverQueue(event, dependencies)
        : await processAshbyQueue(event, dependencies);
    if (result.batchItemFailures.length) return withCors(Response.json({ sourceId, processed: false }, { status: 502 }));
    return withCors(Response.json({ sourceId, processed: true }));
  }
  if (request.method === 'POST' && url.pathname === '/internal/backfill') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const provider = url.searchParams.get('provider') ?? 'all';
    if (!['all', 'github', 'greenhouse', 'lever', 'ashby'].includes(provider)) {
      return withCors(Response.json({ message: 'provider is invalid' }, { status: 400 }));
    }
    const queued: Record<string, number> = {};
    if (provider === 'all' || provider === 'github') {
      await sendQueueMessages(env.GITHUB_QUEUE, defaultSources.map((source) => ({ sourceId: source.id })));
      queued.github = defaultSources.length;
    }
    for (const candidate of ['greenhouse', 'lever', 'ashby'] as const) {
      if (provider === 'all' || provider === candidate) queued[candidate] = await dispatchProviders(env, candidate, new Date(), true);
    }
    return withCors(Response.json({ queued }));
  }
  if (url.pathname.startsWith('/operations/') || url.pathname.startsWith('/internal/operations/')) {
    const queueClient = cloudflareOperationsQueueClient(env);
    const cloudwatch = { async send() { return { MetricAlarms: [] }; } };
    const operations = createSourceOperationsHandler({
      store: new D1InternshipStore(env.DB),
      sharedSecret: env.OPERATIONS_SHARED_SECRET,
      fleets: {
        greenhouse: { queueUrl: 'greenhouse', deadLetterQueueUrl: 'greenhouse-dlq' },
        lever: { queueUrl: 'lever', deadLetterQueueUrl: 'lever-dlq' },
        ashby: { queueUrl: 'ashby', deadLetterQueueUrl: 'ashby-dlq' },
      },
      sqs: queueClient as never,
      cloudwatch: cloudwatch as never,
      alarmTelemetry: {
        status: 'unavailable',
        reason: 'Cloudflare alert policy state is not exposed to this Worker; queue and DLQ counts are live.',
      },
      queueTelemetry: {
        status: 'partial',
        reason: 'queuedMessages is the live total backlog; Cloudflare does not expose a waiting-versus-processing split.',
      },
    });
    const result = await operations({
      requestContext: { http: { method: request.method } },
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(request.headers.entries()),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    });
    return eventResponse(result);
  }
  const authResponse = await handleAuthRequest(request, env);
  if (authResponse) return withCors(authResponse);
  if (request.method === 'POST' && url.pathname === '/installations') {
    const ip = request.headers.get('CF-Connecting-IP')?.trim();
    if (ip) {
      const rateLimit = await consumeAuthRateLimit(env, 'installation:ip', ip, {
        limit: 20,
        windowMs: 60 * 60_000,
        blockMs: 60 * 60_000,
      });
      if (!rateLimit.allowed) {
        return withCors(Response.json({ message: 'Too many installation requests. Try again later.' }, {
          status: 429,
          headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) },
        }));
      }
    }
    return withCors(Response.json(await createInstallation(env), {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    }));
  }
  const handler = createApiHandler({
    jobs: new D1InternshipStore(env.DB),
    users: new D1UserStore(env.DB),
    releases: new D1ReleaseStore(env.DB),
    documentStorage: documentStorage(env),
    deleteIdentity: (id) => deleteAuthUser(id, env),
  });
  if (url.pathname.startsWith('/installation/')) {
    const installationUserId = await authenticatedInstallation(request, env);
    if (!installationUserId) return withCors(Response.json({ message: 'Installation authorization required' }, { status: 401 }));
    const installationPath = url.pathname.slice('/installation'.length);
    const allowed = installationPath === '/preferences'
      || installationPath === '/opening'
      || installationPath === '/devices'
      || installationPath.startsWith('/devices/')
      || installationPath.startsWith('/releases/');
    if (!allowed) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const installationEvent = apiEvent(request, installationUserId, request.method === 'GET' || request.method === 'HEAD' ? null : await request.text());
    installationEvent.rawPath = `/me${installationPath}`;
    return eventResponse(await handler(installationEvent));
  }
  const userId = await authenticatedUser(request, env);
  const contentMatch = url.pathname.match(/^\/me\/documents\/([^/]+)\/content$/u);
  if (contentMatch && (request.method === 'GET' || request.method === 'PUT')) {
    if (!userId) return withCors(Response.json({ message: 'Authentication required' }, { status: 401 }));
    return withCors(await documentContent(request, env, userId, decodeURIComponent(contentMatch[1])));
  }
  const event = apiEvent(request, userId, request.method === 'GET' || request.method === 'HEAD' ? null : await request.text());
  const result = await handler(event);
  return eventResponse(result);
}

async function due<T extends { id: string; status: 'published' | 'shadow' }>(
  sources: T[],
  store: D1InternshipStore,
  now: Date,
  predicate: (source: T, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth) => boolean,
): Promise<T[]> {
  const results: Array<T | undefined> = await Promise.all(sources.map(async (source): Promise<T | undefined> => {
    const checkpointId = source.status === 'shadow' ? `shadow-${source.id}` : source.id;
    const [checkpoint, health] = await Promise.all([store.getCheckpoint(checkpointId), store.getSourceHealth(source.id)]);
    return predicate(source, checkpoint, now, health) ? source : undefined;
  }));
  return results.filter((source): source is T => Boolean(source));
}

async function sendQueueMessages(queue: Queue, messages: unknown[]): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += 100) {
    await queue.sendBatch(messages.slice(offset, offset + 100).map((body) => ({ body })));
  }
}

async function dispatchProviders(
  env: Environment,
  provider: 'greenhouse' | 'lever' | 'ashby',
  now = new Date(),
  force = false,
): Promise<number> {
  const store = new D1InternshipStore(env.DB);
  if (provider === 'greenhouse') {
    const sources = force ? reviewedGreenhouseSources : await due(reviewedGreenhouseSources, store, now, isGreenhouseSourceDue);
    const messages = greenhouseWorkMessages(sources, now);
    await sendQueueMessages(env.GREENHOUSE_QUEUE, messages);
    return messages.length;
  }
  if (provider === 'lever') {
    const dynamic = (await store.listLeverAdmissions?.() ?? []).map(({ source }) => source);
    const registry = [...reviewedLeverSources, ...dynamic];
    const sources = force ? registry : await due(registry, store, now, isLeverSourceDue);
    const messages = leverWorkMessages(sources, now, crypto.randomUUID());
    await sendQueueMessages(env.LEVER_QUEUE, messages);
    return messages.length;
  }
  const sources = force ? reviewedAshbySources : await due(reviewedAshbySources, store, now, isAshbySourceDue);
  const messages = ashbyWorkMessages(sources, now, crypto.randomUUID());
  await sendQueueMessages(env.ASHBY_QUEUE, messages);
  return messages.length;
}

async function refreshCatalogProjection(store: D1InternshipStore) {
  const groups = groupCatalogJobs(await store.listCatalog(), { includeClosed: true }).map(catalogGroupDetails);
  const generatedAt = new Date().toISOString();
  await store.putCatalogProjection(groups, generatedAt);
  return {
    generatedAt,
    groups: groups.length,
    roles: groups.reduce((total, group) => total + group.roles.length, 0),
  };
}

async function scheduledHandler(event: ScheduledController, env: Environment): Promise<void> {
  if (await isShutdown(env)) return;
  const store = new D1InternshipStore(env.DB);
  if (event.cron === '7-57/10 * * * *') {
    if (await queueHasBacklog(env.GITHUB_QUEUE, 'github')) return;
    await sendQueueMessages(env.GITHUB_QUEUE, defaultSources.map((source) => ({ sourceId: source.id })));
    return;
  }
  if (event.cron === '9-59/10 * * * *') {
    const projection = await refreshCatalogProjection(store);
    const notifications = await drainPendingExpoNotifications(store, new D1UserStore(env.DB), new ExpoPushPublisher());
    console.log(JSON.stringify({ event: 'cloudflare_maintenance_complete', projection, notifications }));
    return;
  }
  if (event.cron === '12,42 * * * *') {
    if (!await queueHasBacklog(env.GREENHOUSE_QUEUE, 'greenhouse')) await dispatchProviders(env, 'greenhouse');
    return;
  }
  if (event.cron === '22,52 * * * *') {
    if (!await queueHasBacklog(env.LEVER_QUEUE, 'lever')) await dispatchProviders(env, 'lever');
    return;
  }
  if (event.cron === '2,32 * * * *') {
    if (!await queueHasBacklog(env.ASHBY_QUEUE, 'ashby')) await dispatchProviders(env, 'ashby');
    return;
  }
  if (event.cron === '0 * * * *') {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(event.scheduledTime)));
    if (hour !== 9 && hour !== 17) return;
    if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL || !env.DIGEST_TO_EMAIL) throw new Error('Digest email is not configured');
    await runRuntimeCommand('digest', {
      store,
      config: { sesFrom: env.AUTH_FROM_EMAIL, sesTo: env.DIGEST_TO_EMAIL },
      emailSender: new ResendEmailSender(env.AUTH_FROM_EMAIL, env.DIGEST_TO_EMAIL, env.RESEND_API_KEY),
    });
    return;
  }
  if (event.cron === '42 8 * * *') {
    await cleanupExpiredAuth(env);
    await env.DB.prepare('DELETE FROM user_items WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(Math.floor(Date.now() / 1000)).run();
  }
}

async function queueHandler(batch: MessageBatch<unknown>, env: Environment): Promise<void> {
  if (await isShutdown(env)) {
    for (const message of batch.messages) message.ack();
    return;
  }
  const records = batch.messages.map((message) => ({ messageId: message.id, body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body) }));
  if (batch.queue.includes('github')) {
    const failed = new Set<string>();
    for (const record of records) {
      try {
        const sourceId = (JSON.parse(record.body) as { sourceId?: string }).sourceId;
        const source = defaultSources.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error(`Unknown GitHub source ${JSON.stringify(sourceId)}`);
        await runRuntimeCommand('poll', {
          store: new D1InternshipStore(env.DB),
          userStore: new D1UserStore(env.DB),
          sources: [source],
          validateCatalogOnPoll: false,
          config: { sesFrom: env.AUTH_FROM_EMAIL ?? '', sesTo: env.DIGEST_TO_EMAIL ?? '', ntfyTopic: env.NTFY_TOPIC, ntfyEndpoint: env.NTFY_ENDPOINT },
        });
      } catch (error) {
        failed.add(record.messageId);
        console.error(JSON.stringify({ command: 'github-poll', messageId: record.messageId, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    for (const message of batch.messages) {
      if (failed.has(message.id)) message.retry();
      else message.ack();
    }
    return;
  }
  const event = { Records: records };
  const dependencies = { store: new D1InternshipStore(env.DB), userStore: new D1UserStore(env.DB) };
  const result = batch.queue.includes('greenhouse')
    ? await processGreenhouseQueue(event, dependencies)
    : batch.queue.includes('lever')
      ? await processLeverQueue(event, dependencies)
      : await processAshbyQueue(event, dependencies);
  const failed = new Set(result.batchItemFailures.map(({ itemIdentifier }) => itemIdentifier));
  for (const message of batch.messages) {
    if (failed.has(message.id)) message.retry();
    else message.ack();
  }
}

export default {
  fetch: fetchHandler,
  scheduled: scheduledHandler,
  queue: queueHandler,
};
