import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { reviewedGreenhouseSources } from './sources/greenhouse-config.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { DynamoInternshipStore, type InternshipStore } from './store.js';
import { acceptLeverAdmission, listLeverCandidates, verifyLeverAdmission, type LeverAdmissionInput } from './lever-admission.js';
import { monitoringChecklistItems, monitoringPeriod, publicMonitoringChecklist } from './monitoring-checklist.js';
import type { MonitoringChecklist, MonitoringChecklistItemId, SourceCheckpoint, SourceHealth, SourceHealthState } from './types.js';

type ApiEvent = {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
  rawPath?: string;
  routeKey?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
};

const responseHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Headers': 'Content-Type,X-Operations-Key',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const reply = (statusCode: number, body: unknown) => ({ statusCode, headers: responseHeaders, body: JSON.stringify(body) });
const healthWindowMs = 30 * 60_000;
const inactiveHealthWindowMs = 7 * 60 * 60_000;
type Provider = 'greenhouse' | 'lever';
type OperationsSource =
  | (typeof reviewedGreenhouseSources[number] & { provider: 'greenhouse' })
  | (ReviewedLeverSource & { provider: 'lever' });
type FleetConfiguration = Record<Provider, { queueUrl: string; deadLetterQueueUrl: string } | undefined>;

function header(event: ApiEvent, name: string): string | undefined {
  const match = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function authorized(event: ApiEvent, expectedSecret: string): boolean {
  const supplied = header(event, 'x-operations-key');
  if (!supplied || !expectedSecret) return false;
  const actual = createHash('sha256').update(supplied).digest();
  const expected = createHash('sha256').update(expectedSecret).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function stateFor(health: SourceHealth | undefined, checkpoint: SourceCheckpoint | undefined, timestamp: number): SourceHealthState {
  if (health?.state === 'quarantined') return 'quarantined';
  const lastSuccessAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  if (!lastSuccessAt) return health?.state ?? 'never-succeeded';
  const allowedAge = health?.pollTier === 'quiet'
    ? inactiveHealthWindowMs
    : (checkpoint?.lastRowCount ?? health?.eligibleRows ?? 0) > 0 ? healthWindowMs : inactiveHealthWindowMs;
  if (timestamp - Date.parse(lastSuccessAt) > allowedAge || health?.state === 'degraded') return 'degraded';
  return 'healthy';
}

function publicSource(
  source: OperationsSource,
  health: SourceHealth | undefined,
  checkpoint: SourceCheckpoint | undefined,
  timestamp: number,
) {
  const lastSuccessAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  const recentRuns = health?.recentRuns ?? [];
  const successfulRuns = recentRuns.filter((run) => run.state === 'succeeded').length;
  const state = stateFor(health, checkpoint, timestamp);
  return {
    source: {
      sourceId: source.id,
      provider: source.provider,
      region: source.provider === 'lever' ? source.region : 'unknown',
      displayName: source.provider === 'lever' ? source.company : source.displayName,
      careersUrl: source.careersUrl,
      mode: source.status,
      boardToken: source.provider === 'lever' ? source.site : source.boardToken,
      evidenceStatus: source.evidenceStatus,
    },
    state,
    ...(lastSuccessAt ? { lastSuccessfulSnapshotAt: lastSuccessAt, ageSeconds: Math.max(0, Math.floor((timestamp - Date.parse(lastSuccessAt)) / 1000)) } : {}),
    lastAttemptAt: health?.lastAttemptAt ?? lastSuccessAt,
    quarantined: state === 'quarantined',
    quarantineReason: health?.quarantineReason,
    diagnostic: health?.diagnostic,
    failureCategory: health?.failureCategory,
    outcome: health?.outcome,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    sourceStatus: health?.sourceStatus ?? 'active',
    pollTier: health?.pollTier ?? ((checkpoint?.lastRowCount ?? 0) > 0 ? 'active' : 'quiet'),
    backoffUntil: health?.backoffUntil,
    incidentState: health?.incidentState,
    incidentSeverity: health?.incidentSeverity,
    rawRows: health?.rawRows ?? checkpoint?.lastRawRowCount,
    eligibleRows: health?.eligibleRows ?? checkpoint?.lastRowCount,
    withheldRows: health?.withheldRows ?? checkpoint?.lastWithheldRowCount ?? 0,
    recentRuns: recentRuns.length,
    successRate: recentRuns.length ? successfulRuns / recentRuns.length : lastSuccessAt ? 1 : 0,
  };
}

async function fleetStatus(
  provider: Provider,
  configuration: NonNullable<FleetConfiguration[Provider]>,
  sqs: SQSClient,
  cloudwatch: CloudWatchClient,
) {
  const [queue, deadLetter, alarms] = await Promise.all([
    sqs.send(new GetQueueAttributesCommand({
      QueueUrl: configuration.queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })),
    sqs.send(new GetQueueAttributesCommand({
      QueueUrl: configuration.deadLetterQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })),
    cloudwatch.send(new DescribeAlarmsCommand({
      AlarmNamePrefix: provider === 'greenhouse' ? 'InternNotifsGreenhouse-' : 'InternNotifsLever-',
    })),
  ]);
  const number = (value: string | undefined) => Number(value ?? 0);
  return {
    provider,
    queue: {
      waiting: number(queue.Attributes?.ApproximateNumberOfMessages),
      processing: number(queue.Attributes?.ApproximateNumberOfMessagesNotVisible),
      deadLettered: number(deadLetter.Attributes?.ApproximateNumberOfMessages) + number(deadLetter.Attributes?.ApproximateNumberOfMessagesNotVisible),
    },
    alarms: (alarms.MetricAlarms ?? []).map((alarm) => ({
      name: alarm.AlarmName,
      state: alarm.StateValue,
      updatedAt: alarm.StateUpdatedTimestamp?.toISOString(),
      description: alarm.AlarmDescription,
    })),
  };
}

async function providerFleets(
  configured: FleetConfiguration,
  ssm: SSMClient,
  parameterPrefix?: string,
): Promise<FleetConfiguration> {
  if (!parameterPrefix || (configured.greenhouse && configured.lever)) return configured;
  const response = await ssm.send(new GetParametersByPathCommand({
    Path: parameterPrefix,
    Recursive: true,
    WithDecryption: false,
  }));
  const values = new Map((response.Parameters ?? []).flatMap((parameter) => (
    parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []
  )));
  const fromParameters = (provider: Provider) => {
    const queueUrl = values.get(`${parameterPrefix}/${provider}/queue-url`);
    const deadLetterQueueUrl = values.get(`${parameterPrefix}/${provider}/dead-letter-queue-url`);
    return queueUrl && deadLetterQueueUrl ? { queueUrl, deadLetterQueueUrl } : undefined;
  };
  return {
    greenhouse: configured.greenhouse ?? fromParameters('greenhouse'),
    lever: configured.lever ?? fromParameters('lever'),
  };
}

export interface SourceOperationsDependencies {
  store: InternshipStore;
  sharedSecret: string;
  fleets?: FleetConfiguration;
  queueUrl?: string;
  deadLetterQueueUrl?: string;
  parameterPrefix?: string;
  sqs?: SQSClient;
  cloudwatch?: CloudWatchClient;
  ssm?: SSMClient;
  now?: () => Date;
}

function parseBody(event: ApiEvent): Record<string, unknown> {
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  return JSON.parse(body) as Record<string, unknown>;
}

export function createSourceOperationsHandler(dependencies: SourceOperationsDependencies) {
  return async (event: ApiEvent) => {
    const method = event.requestContext?.http?.method ?? event.routeKey?.split(' ')[0] ?? 'GET';
    if (method === 'OPTIONS') return reply(204, {});
    if (!authorized(event, dependencies.sharedSecret)) return reply(401, { code: 'AUTHENTICATION_REQUIRED', message: 'Operations credentials were rejected.' });

    const timestamp = (dependencies.now ?? (() => new Date()))().getTime();
    const path = (event.rawPath ?? event.routeKey?.split(' ')[1] ?? '/').replace(/^\/internal(?=\/)/, '');
    const dynamicAdmissions = await (dependencies.store.listLeverAdmissions?.() ?? Promise.resolve([]));
    if (path === '/operations/lever/candidates' && method === 'GET') {
      const candidates = await listLeverCandidates(dependencies.store, new Date(timestamp));
      return reply(200, { generatedAt: new Date(timestamp).toISOString(), candidates, admissions: dynamicAdmissions });
    }
    const leverAction = path.match(/^\/operations\/lever\/candidates\/([^/]+)\/(verify|accept)$/);
    if (leverAction && method === 'POST') {
      let input: LeverAdmissionInput;
      try {
        const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
        input = JSON.parse(body) as LeverAdmissionInput;
      } catch {
        return reply(400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' });
      }
      const site = decodeURIComponent(leverAction[1]);
      try {
        if (leverAction[2] === 'verify') {
          return reply(200, await verifyLeverAdmission(dependencies.store, site, input, { now: dependencies.now }));
        }
        const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
        return reply(201, await acceptLeverAdmission(dependencies.store, site, input, actor, { now: dependencies.now }));
      } catch (error) {
        return reply(422, {
          code: leverAction[2] === 'verify' ? 'VERIFICATION_FAILED' : 'ADMISSION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const leverById = new Map<string, ReviewedLeverSource>();
    for (const source of reviewedLeverSources) leverById.set(source.id, source);
    for (const admission of dynamicAdmissions) leverById.set(admission.source.id, admission.source);
    const sources: OperationsSource[] = [
      ...reviewedGreenhouseSources.map((source) => ({ ...source, provider: 'greenhouse' as const })),
      ...[...leverById.values()].map((source) => ({ ...source, provider: 'lever' as const })),
    ];
    const ids = sources.map((source) => source.id);
    const checklistPeriod = monitoringPeriod(new Date(timestamp));
    const [healthRecords, checkpoints, storedChecklist] = await Promise.all([
      dependencies.store.getSourceHealthMany(ids),
      Promise.all(sources.map((source) => dependencies.store.getCheckpoint(
        source.provider === 'lever' && source.status === 'shadow' ? `shadow-${source.id}` : source.id,
      ))),
      dependencies.store.getMonitoringChecklist(checklistPeriod),
    ]);
    const health = new Map(healthRecords.map((record) => [record.sourceId, record]));
    const rows = sources.map((source, index) => publicSource(source, health.get(source.id), checkpoints[index], timestamp));

    const checklistMatch = path.match(/^\/operations\/checklist\/([^/]+)$/);
    if (checklistMatch && method === 'POST') {
      const itemId = decodeURIComponent(checklistMatch[1]) as MonitoringChecklistItemId;
      if (!monitoringChecklistItems.some((item) => item.id === itemId)) {
        return reply(404, { code: 'CHECKLIST_ITEM_NOT_FOUND', message: 'Checklist item not found.' });
      }
      let input: Record<string, unknown>;
      try { input = parseBody(event); }
      catch { return reply(400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' }); }
      if (typeof input.completed !== 'boolean') {
        return reply(400, { code: 'INVALID_REQUEST', message: 'completed must be a boolean.' });
      }
      const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
      const changedAt = new Date(timestamp).toISOString();
      const checklist: MonitoringChecklist = storedChecklist ?? {
        period: checklistPeriod,
        completions: {},
        version: 0,
      };
      const completions = { ...checklist.completions };
      if (input.completed) completions[itemId] = { completedAt: changedAt, completedBy: actor };
      else delete completions[itemId];
      const updated: MonitoringChecklist = {
        ...checklist,
        completions,
        updatedAt: changedAt,
        updatedBy: actor,
        version: checklist.version + 1,
      };
      await dependencies.store.putMonitoringChecklist(updated);
      console.log(JSON.stringify({
        event: 'monitoring_checklist_changed',
        period: checklistPeriod,
        itemId,
        completed: input.completed,
        actor,
        version: updated.version,
      }));
      return reply(200, publicMonitoringChecklist(updated, checklistPeriod));
    }

    const actionMatch = path.match(/^\/operations\/sources\/([^/]+)\/actions$/);
    if (actionMatch && method === 'POST') {
      const sourceId = decodeURIComponent(actionMatch[1]);
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source) return reply(404, { code: 'SOURCE_NOT_FOUND', message: 'Source not found.' });
      let input: Record<string, unknown>;
      try { input = parseBody(event); }
      catch { return reply(400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' }); }
      const action = input.action;
      const allowed = ['pause', 'resume', 'replay', 'acknowledge', 'resolve', 'set-tier'];
      if (typeof action !== 'string' || !allowed.includes(action)) {
        return reply(400, { code: 'INVALID_ACTION', message: 'Action must be pause, resume, replay, acknowledge, resolve, or set-tier.' });
      }
      const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
      const changedAt = new Date(timestamp).toISOString();
      const previous = health.get(sourceId);
      const base: SourceHealth = previous ?? {
        sourceId,
        provider: source.provider,
        region: source.provider === 'lever' ? source.region : 'unknown',
        state: 'never-succeeded',
        lastAttemptAt: changedAt,
        consecutiveFailures: 0,
        durationMs: 0,
      };
      let updated = {
        ...base,
        configVersion: (base.configVersion ?? 0) + 1,
        changedAt,
        changedBy: actor,
      };
      if (action === 'pause') updated = { ...updated, sourceStatus: 'paused' };
      if (action === 'resume') {
        const withoutBackoff = { ...updated };
        delete withoutBackoff.backoffUntil;
        updated = { ...withoutBackoff, sourceStatus: 'active' };
      }
      if (action === 'set-tier') {
        if (input.pollTier !== 'active' && input.pollTier !== 'quiet') {
          return reply(400, { code: 'INVALID_POLL_TIER', message: 'pollTier must be active or quiet.' });
        }
        updated = { ...updated, pollTier: input.pollTier, pollTierMode: 'operator' };
      }
      if (action === 'acknowledge') {
        if (!base.incidentState || base.incidentState === 'resolved') {
          return reply(409, { code: 'NO_OPEN_INCIDENT', message: 'This source has no open incident to acknowledge.' });
        }
        updated = { ...updated, incidentState: 'acknowledged', incidentAcknowledgedAt: changedAt, incidentUpdatedAt: changedAt };
      }
      if (action === 'resolve') {
        updated = { ...updated, incidentState: 'resolved', incidentResolvedAt: changedAt, incidentUpdatedAt: changedAt };
      }
      if (action === 'replay') {
        const configuredFleets = await providerFleets(
          dependencies.fleets ?? {
            greenhouse: dependencies.queueUrl && dependencies.deadLetterQueueUrl
              ? { queueUrl: dependencies.queueUrl, deadLetterQueueUrl: dependencies.deadLetterQueueUrl }
              : undefined,
            lever: undefined,
          },
          dependencies.ssm ?? new SSMClient({}),
          dependencies.parameterPrefix,
        );
        const fleet = configuredFleets[source.provider];
        if (!fleet) return reply(503, { code: 'PROVIDER_QUEUE_UNAVAILABLE', message: `${source.provider} replay is not configured.` });
        const runId = `operator-${randomUUID()}`;
        await (dependencies.sqs ?? new SQSClient({})).send(new SendMessageCommand({
          QueueUrl: fleet.queueUrl,
          MessageBody: JSON.stringify({ version: 1, sourceId, scheduledAt: changedAt, force: true, ...(source.provider === 'lever' ? { runId } : {}) }),
          MessageGroupId: sourceId,
          MessageDeduplicationId: runId,
        }));
        console.log(JSON.stringify({ event: 'source_replay_requested', sourceId, provider: source.provider, runId, actor }));
        return reply(202, { sourceId, action, runId, queuedAt: changedAt });
      }
      await dependencies.store.putSourceHealth(updated);
      console.log(JSON.stringify({
        event: action === 'pause' || action === 'resume' || action === 'set-tier'
          ? 'source_setting_changed'
          : 'source_incident_state_changed',
        sourceId,
        provider: source.provider,
        action,
        actor,
        configVersion: updated.configVersion,
      }));
      return reply(200, { sourceId, action, health: updated });
    }
    if (method !== 'GET') return reply(405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });

    if (path === '/operations/sources') {
      const configuredFleets = await providerFleets(
        dependencies.fleets ?? {
          greenhouse: dependencies.queueUrl && dependencies.deadLetterQueueUrl
            ? { queueUrl: dependencies.queueUrl, deadLetterQueueUrl: dependencies.deadLetterQueueUrl }
            : undefined,
          lever: undefined,
        },
        dependencies.ssm ?? new SSMClient({}),
        dependencies.parameterPrefix,
      );
      const fleetRows = (await Promise.all(
        (Object.entries(configuredFleets) as Array<[Provider, FleetConfiguration[Provider]]>)
          .flatMap(([provider, configuration]) => configuration
            ? [fleetStatus(provider, configuration, dependencies.sqs ?? new SQSClient({}), dependencies.cloudwatch ?? new CloudWatchClient({}))]
            : []),
      ));
      const fleet = {
        queue: fleetRows.reduce((total, row) => ({
          waiting: total.waiting + row.queue.waiting,
          processing: total.processing + row.queue.processing,
          deadLettered: total.deadLettered + row.queue.deadLettered,
        }), { waiting: 0, processing: 0, deadLettered: 0 }),
        alarms: fleetRows.flatMap((row) => row.alarms),
      };
      const cutoff = timestamp - 24 * 60 * 60_000;
      const failedExtractions24h = healthRecords.reduce((total, record) => total + (record.recentRuns ?? [])
        .filter((run) => run.state !== 'succeeded' && Date.parse(run.completedAt) >= cutoff).length, 0);
      const productionMetrics = {
        deadLetterMessages: fleet.queue.deadLettered,
        failedExtractions24h,
        staleSources: rows.filter((row) => row.state === 'degraded' || row.state === 'never-succeeded').length,
        quarantinedSources: rows.filter((row) => row.state === 'quarantined').length,
        pausedSources: rows.filter((row) => row.sourceStatus === 'paused').length,
        activeAlarms: fleet.alarms.filter((alarm) => alarm.state === 'ALARM').length,
        queuedMessages: fleet.queue.waiting,
        processingMessages: fleet.queue.processing,
      };
      const order: Record<SourceHealthState, number> = { quarantined: 0, degraded: 1, 'never-succeeded': 2, healthy: 3 };
      return reply(200, {
        generatedAt: new Date(timestamp).toISOString(),
        sources: rows,
        reliabilityRanking: [...rows].sort((a, b) => order[a.state] - order[b.state] || b.consecutiveFailures - a.consecutiveFailures || a.source.displayName.localeCompare(b.source.displayName)),
        fleet,
        fleets: fleetRows,
        productionMetrics,
        checklist: publicMonitoringChecklist(storedChecklist, checklistPeriod),
      });
    }
    const match = path.match(/^\/operations\/sources\/([^/]+)$/);
    if (!match) return reply(404, { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' });
    const sourceId = decodeURIComponent(match[1]);
    const row = rows.find((candidate) => candidate.source.sourceId === sourceId);
    if (!row) return reply(404, { code: 'SOURCE_NOT_FOUND', message: 'Source not found.' });
    const record = health.get(sourceId);
    return reply(200, {
      generatedAt: new Date(timestamp).toISOString(),
      ...row,
      health: { state: row.state, ageSeconds: row.ageSeconds },
      recentRuns: record?.recentRuns ?? [],
    });
  };
}

/** Backward-compatible name retained for existing imports and the stable stack. */
export const createGreenhouseOperationsHandler = createSourceOperationsHandler;

const tableName = process.env.INTERNSHIPS_TABLE;
const queueUrl = process.env.GREENHOUSE_QUEUE_URL;
const deadLetterQueueUrl = process.env.GREENHOUSE_DEAD_LETTER_QUEUE_URL;
const sharedSecret = process.env.OPERATIONS_SHARED_SECRET;
const parameterPrefix = process.env.OPERATIONS_PROVIDER_PARAMETER_PREFIX;

export const handler = async (event: ApiEvent) => {
  if (!tableName || !sharedSecret || ((!queueUrl || !deadLetterQueueUrl) && !parameterPrefix)) {
    return reply(500, { code: 'OPERATIONS_NOT_CONFIGURED', message: 'Source operations data is not configured.' });
  }
  return createSourceOperationsHandler({
    store: new DynamoInternshipStore(tableName),
    queueUrl,
    deadLetterQueueUrl,
    parameterPrefix,
    sharedSecret,
  })(event);
};
