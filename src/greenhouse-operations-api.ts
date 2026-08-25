import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { reviewedGreenhouseSources } from './sources/greenhouse-config.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { reviewedAshbySources, type ReviewedAshbySource } from './sources/ashby-config.js';
import { DynamoInternshipStore, type InternshipStore } from './store.js';
import { acceptLeverAdmission, listLeverCandidates, verifyLeverAdmission, type LeverAdmissionInput } from './lever-admission.js';
import { monitoringChecklistItems, monitoringPeriod, publicMonitoringChecklist } from './monitoring-checklist.js';
import { occurrenceStatus } from './ingestion/monitoring.js';
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
const activeHealthWindowMs: Record<Provider, number> = {
  greenhouse: 90 * 60_000,
  lever: 90 * 60_000,
  ashby: 90 * 60_000,
};
const inactiveHealthWindowMs = 7 * 60 * 60_000;
type Provider = 'greenhouse' | 'lever' | 'ashby';
type OperationsSource =
  | (typeof reviewedGreenhouseSources[number] & { provider: 'greenhouse' })
  | (ReviewedLeverSource & { provider: 'lever' })
  | (ReviewedAshbySource & { provider: 'ashby' });
type FleetConfiguration = Partial<Record<Provider, { queueUrl: string; deadLetterQueueUrl: string }>>;

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

function stateFor(source: OperationsSource, health: SourceHealth | undefined, checkpoint: SourceCheckpoint | undefined, timestamp: number): SourceHealthState {
  if (health?.state === 'quarantined') return 'quarantined';
  const lastSuccessAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  if (!lastSuccessAt) return health?.state ?? 'never-succeeded';
  const allowedAge = source.status === 'shadow' || health?.pollTier === 'quiet'
    ? inactiveHealthWindowMs
    : (checkpoint?.lastRowCount ?? health?.eligibleRows ?? 0) > 0 ? activeHealthWindowMs[source.provider] : inactiveHealthWindowMs;
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
  const state = stateFor(source, health, checkpoint, timestamp);
  return {
    source: {
      sourceId: source.id,
      provider: source.provider,
      region: source.provider === 'lever' ? source.region : source.provider === 'ashby' ? source.identity.apiRegion : 'unknown',
      displayName: source.provider === 'greenhouse' ? source.displayName : source.company,
      careersUrl: source.careersUrl,
      mode: source.status,
      boardToken: source.provider === 'lever' ? source.site : source.provider === 'ashby' ? source.identity.boardKey : source.boardToken,
      evidenceStatus: source.provider === 'ashby' ? source.evidenceState : source.evidenceStatus,
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
    applicationLinksChecked: health?.applicationLinksChecked,
    applicationLinkFailures: health?.applicationLinkFailures,
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
      AlarmNamePrefix: `InternNotifs${provider[0]!.toUpperCase()}${provider.slice(1)}-`,
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

async function applicationAlarms(cloudwatch: CloudWatchClient) {
  const response = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: 'InternNotifs-' }));
  return (response.MetricAlarms ?? []).map((alarm) => ({
    name: alarm.AlarmName,
    state: alarm.StateValue,
    updatedAt: alarm.StateUpdatedTimestamp?.toISOString(),
    description: alarm.AlarmDescription,
  }));
}

async function providerFleets(
  configured: FleetConfiguration,
  ssm: SSMClient,
  parameterPrefix?: string,
): Promise<FleetConfiguration> {
  if (!parameterPrefix || (configured.greenhouse && configured.lever && configured.ashby)) return configured;
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
    ashby: configured.ashby ?? fromParameters('ashby'),
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
  alarmTelemetry?: { status: 'available' | 'unavailable'; reason?: string };
  queueTelemetry?: { status: 'available' | 'partial'; reason?: string };
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
      ...reviewedAshbySources.map((source) => ({ ...source, provider: 'ashby' as const })),
    ];
    const ids = sources.map((source) => source.id);
    const checklistPeriod = monitoringPeriod(new Date(timestamp));
    const [healthRecords, checkpoints, storedChecklist] = await Promise.all([
      dependencies.store.getSourceHealthMany(ids),
      Promise.all(sources.map((source) => dependencies.store.getCheckpoint(
        source.provider !== 'greenhouse' && source.status === 'shadow' ? `shadow-${source.id}` : source.id,
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

    const attributionMatch = path.match(/^\/operations\/attribution\/([^/]+)$/);
    if (attributionMatch) {
      if (method !== 'GET') return reply(405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
      const jobId = decodeURIComponent(attributionMatch[1]);
      const job = await dependencies.store.getJob(jobId);
      if (!job) return reply(404, { code: 'JOB_NOT_FOUND', message: 'Catalog job not found.' });
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const referenceSourceIds = [...new Set(job.sourceReferences.map((reference) => reference.sourceId))];
      const [occurrenceEntries, attributionCheckpoints, attributionHealthRecords] = await Promise.all([
        Promise.all(referenceSourceIds.map(async (sourceId) => [sourceId, await dependencies.store.getSourceOccurrences(sourceId)] as const)),
        Promise.all(referenceSourceIds.map((sourceId) => dependencies.store.getCheckpoint(sourceId))),
        dependencies.store.getSourceHealthMany(referenceSourceIds),
      ]);
      const occurrencesBySourceId = new Map(occurrenceEntries);
      const checkpointBySourceId = new Map(referenceSourceIds.map((sourceId, index) => [sourceId, attributionCheckpoints[index]]));
      const healthBySourceId = new Map(attributionHealthRecords.map((record) => [record.sourceId, record]));
      const occurrences = job.sourceReferences.map((reference) => {
        const candidates = occurrencesBySourceId.get(reference.sourceId) ?? [];
        const state = candidates.find((candidate) => candidate.externalId === reference.externalId)
          ?? candidates.find((candidate) => candidate.occurrence.document === reference.document && candidate.occurrence.row === reference.row);
        const source = sourceById.get(reference.sourceId);
        const status = state ? occurrenceStatus(state, checkpointBySourceId.get(reference.sourceId), healthBySourceId.get(reference.sourceId)) : undefined;
        return {
          sourceId: reference.sourceId,
          sourceKind: source ? 'direct-provider' as const : 'aggregator' as const,
          externalId: reference.externalId,
          firstObservedAt: status?.firstObservedAt,
          firstObservedAtPrecision: status?.firstObservedAtPrecision ?? 'unknown',
          lastConfirmedAt: status?.lastConfirmedAt,
          firstAttachedAt: reference.firstAttachedAt,
          firstAttachedAtPrecision: reference.firstAttachedAtPrecision ?? 'unknown',
          providerTimestamp: reference.providerTimestamp,
        };
      });
      const firstExact = (kind: 'direct-provider' | 'aggregator') => occurrences
        .filter((item) => item.sourceKind === kind && item.firstObservedAtPrecision === 'exact' && item.firstObservedAt)
        .sort((a, b) => a.firstObservedAt!.localeCompare(b.firstObservedAt!))[0];
      const providerFirst = firstExact('direct-provider');
      const aggregatorFirst = firstExact('aggregator');
      const providerMinusAggregatorLagMs = providerFirst && aggregatorFirst
        ? Date.parse(providerFirst.firstObservedAt!) - Date.parse(aggregatorFirst.firstObservedAt!)
        : undefined;
      return reply(200, {
        generatedAt: new Date(timestamp).toISOString(),
        jobId: job.jobId,
        occurrences,
        providerFirstObservedAt: providerFirst?.firstObservedAt,
        aggregatorFirstObservedAt: aggregatorFirst?.firstObservedAt,
        // Positive means the aggregator was seen first; negative means a direct provider was seen first.
        ...(providerMinusAggregatorLagMs === undefined ? {} : { providerMinusAggregatorLagMs }),
      });
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
      const allowed = ['pause', 'resume', 'replay', 'quarantine', 'recover', 'acknowledge', 'resolve', 'set-tier'];
      if (typeof action !== 'string' || !allowed.includes(action)) {
        return reply(400, { code: 'INVALID_ACTION', message: 'Action must be pause, resume, replay, quarantine, recover, acknowledge, resolve, or set-tier.' });
      }
      const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
      const changedAt = new Date(timestamp).toISOString();
      const previous = health.get(sourceId);
      const base: SourceHealth = previous ?? {
        sourceId,
        provider: source.provider,
        region: source.provider === 'lever' ? source.region : source.provider === 'ashby' ? source.identity.apiRegion : 'unknown',
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
      if (action === 'quarantine') {
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (!reason || reason.length > 500) {
          return reply(400, { code: 'INVALID_QUARANTINE_REASON', message: 'A quarantine reason between 1 and 500 characters is required.' });
        }
        updated = {
          ...updated,
          state: 'quarantined',
          sourceStatus: 'paused',
          diagnostic: reason,
          lastSafeDiagnostic: reason,
          quarantineReason: reason,
          quarantinedAt: changedAt,
          incidentState: 'open',
          incidentSeverity: 'high',
          incidentOpenedAt: base.incidentOpenedAt ?? changedAt,
          incidentUpdatedAt: changedAt,
        };
      }
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
      if (action === 'replay' || action === 'recover') {
        if (action === 'recover' && base.state !== 'quarantined') {
          return reply(409, { code: 'SOURCE_NOT_QUARANTINED', message: 'Recovery requires a quarantined source.' });
        }
        const configuredFleets = await providerFleets(
          dependencies.fleets ?? {
            greenhouse: dependencies.queueUrl && dependencies.deadLetterQueueUrl
              ? { queueUrl: dependencies.queueUrl, deadLetterQueueUrl: dependencies.deadLetterQueueUrl }
              : undefined,
            lever: undefined,
            ashby: undefined,
          },
          dependencies.ssm ?? new SSMClient({}),
          dependencies.parameterPrefix,
        );
        const fleet = configuredFleets[source.provider];
        if (!fleet) return reply(503, { code: 'PROVIDER_QUEUE_UNAVAILABLE', message: `${source.provider} replay is not configured.` });
        if (action === 'recover') {
          updated = { ...updated, sourceStatus: 'paused', incidentState: 'acknowledged', incidentAcknowledgedAt: changedAt, incidentUpdatedAt: changedAt };
          await dependencies.store.putSourceHealth(updated);
        }
        const runId = `${action === 'recover' ? 'recovery' : 'operator'}-${randomUUID()}`;
        try {
          await (dependencies.sqs ?? new SQSClient({})).send(new SendMessageCommand({
            QueueUrl: fleet.queueUrl,
            MessageBody: JSON.stringify({ version: 1, sourceId, scheduledAt: changedAt, force: true, ...(source.provider !== 'greenhouse' ? { runId } : {}) }),
            MessageGroupId: sourceId,
            MessageDeduplicationId: runId,
          }));
        } catch (error) {
          if (action !== 'recover') throw error;
          const enqueueFailed = {
            ...updated,
            incidentState: base.incidentState ?? 'open' as const,
            incidentUpdatedAt: changedAt,
          };
          if (base.incidentAcknowledgedAt) enqueueFailed.incidentAcknowledgedAt = base.incidentAcknowledgedAt;
          else delete enqueueFailed.incidentAcknowledgedAt;
          await dependencies.store.putSourceHealth(enqueueFailed);
          console.error(JSON.stringify({ event: 'source_recovery_enqueue_failed', sourceId, provider: source.provider, runId, actor }));
          return reply(503, { code: 'RECOVERY_ENQUEUE_FAILED', message: 'Recovery validation could not be queued.' });
        }
        console.log(JSON.stringify({ event: action === 'recover' ? 'source_recovery_requested' : 'source_replay_requested', sourceId, provider: source.provider, runId, actor }));
        return reply(202, { sourceId, action, runId, queuedAt: changedAt, ...(action === 'recover' ? { sourceStatus: 'paused' } : {}) });
      }
      await dependencies.store.putSourceHealth(updated);
      console.log(JSON.stringify({
        event: action === 'pause' || action === 'resume' || action === 'set-tier' || action === 'quarantine'
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
          ashby: undefined,
        },
        dependencies.ssm ?? new SSMClient({}),
        dependencies.parameterPrefix,
      );
      const cloudwatch = dependencies.cloudwatch ?? new CloudWatchClient({});
      const [fleetRows, allApplicationAlarms, legacyPendingNotifications] = await Promise.all([
        Promise.all(
        (Object.entries(configuredFleets) as Array<[Provider, FleetConfiguration[Provider]]>)
          .flatMap(([provider, configuration]) => configuration
            ? [fleetStatus(provider, configuration, dependencies.sqs ?? new SQSClient({}), cloudwatch)]
            : []),
        ),
        applicationAlarms(cloudwatch),
        dependencies.store.pendingSms().then((jobs) => jobs.length),
      ]);
      const alarmsByName = new Map(allApplicationAlarms.flatMap((alarm) => alarm.name ? [[alarm.name, alarm] as const] : []));
      for (const alarm of fleetRows.flatMap((row) => row.alarms)) {
        if (alarm.name) alarmsByName.set(alarm.name, alarm);
      }
      const queueTelemetry = dependencies.queueTelemetry ?? { status: 'available' as const };
      const queue = fleetRows.reduce((total, row) => ({
          waiting: total.waiting + row.queue.waiting,
          processing: total.processing + row.queue.processing,
          deadLettered: total.deadLettered + row.queue.deadLettered,
        }), { waiting: 0, processing: 0, deadLettered: 0 });
      const fleet = {
        queue: { ...queue, processing: queueTelemetry.status === 'available' ? queue.processing : null },
        queueTelemetry,
        alarms: [...alarmsByName.values()],
        alarmTelemetry: dependencies.alarmTelemetry ?? { status: 'available' as const },
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
        activeAlarms: fleet.alarmTelemetry.status === 'available'
          ? fleet.alarms.filter((alarm) => alarm.state === 'ALARM').length
          : null,
        queuedMessages: fleet.queue.waiting,
        processingMessages: fleet.queue.processing,
        legacyPendingNotifications,
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
