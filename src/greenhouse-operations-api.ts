import { createHash, timingSafeEqual } from 'node:crypto';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { reviewedGreenhouseSources } from './sources/greenhouse-config.js';
import { DynamoInternshipStore, type InternshipStore } from './store.js';
import type { SourceCheckpoint, SourceHealth, SourceHealthState } from './types.js';

type ApiEvent = {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
  rawPath?: string;
  routeKey?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
};

const responseHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Headers': 'Content-Type,X-Operations-Key',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};
const reply = (statusCode: number, body: unknown) => ({ statusCode, headers: responseHeaders, body: JSON.stringify(body) });
const healthWindowMs = 30 * 60_000;
const inactiveHealthWindowMs = 7 * 60 * 60_000;

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
  const allowedAge = (checkpoint?.lastRowCount ?? health?.eligibleRows ?? 0) > 0 ? healthWindowMs : inactiveHealthWindowMs;
  if (timestamp - Date.parse(lastSuccessAt) > allowedAge || health?.state === 'degraded') return 'degraded';
  return 'healthy';
}

function publicSource(
  source: typeof reviewedGreenhouseSources[number],
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
      provider: 'greenhouse',
      displayName: source.displayName,
      careersUrl: source.careersUrl,
      mode: source.status,
      boardToken: source.boardToken,
      evidenceStatus: source.evidenceStatus,
    },
    state,
    ...(lastSuccessAt ? { lastSuccessfulSnapshotAt: lastSuccessAt, ageSeconds: Math.max(0, Math.floor((timestamp - Date.parse(lastSuccessAt)) / 1000)) } : {}),
    lastAttemptAt: health?.lastAttemptAt ?? lastSuccessAt,
    quarantined: state === 'quarantined',
    quarantineReason: health?.quarantineReason,
    diagnostic: health?.diagnostic,
    failureCategory: health?.failureCategory,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    rawRows: health?.rawRows ?? checkpoint?.lastRawRowCount,
    eligibleRows: health?.eligibleRows ?? checkpoint?.lastRowCount,
    withheldRows: health?.withheldRows ?? checkpoint?.lastWithheldRowCount ?? 0,
    recentRuns: recentRuns.length,
    successRate: recentRuns.length ? successfulRuns / recentRuns.length : lastSuccessAt ? 1 : 0,
  };
}

async function fleetStatus(queueUrl: string, deadLetterQueueUrl: string, sqs: SQSClient, cloudwatch: CloudWatchClient) {
  const [queue, deadLetter, alarms] = await Promise.all([
    sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })),
    sqs.send(new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })),
    cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: 'InternNotifsGreenhouse-' })),
  ]);
  const number = (value: string | undefined) => Number(value ?? 0);
  return {
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

export function createGreenhouseOperationsHandler(dependencies: {
  store: Pick<InternshipStore, 'getCheckpoint' | 'getSourceHealthMany'>;
  queueUrl: string;
  deadLetterQueueUrl: string;
  sharedSecret: string;
  sqs?: SQSClient;
  cloudwatch?: CloudWatchClient;
  now?: () => Date;
}) {
  return async (event: ApiEvent) => {
    const method = event.requestContext?.http?.method ?? event.routeKey?.split(' ')[0] ?? 'GET';
    if (method === 'OPTIONS') return reply(204, {});
    if (!authorized(event, dependencies.sharedSecret)) return reply(401, { code: 'AUTHENTICATION_REQUIRED', message: 'Operations credentials were rejected.' });
    if (method !== 'GET') return reply(405, { code: 'METHOD_NOT_ALLOWED', message: 'The operations API is read-only.' });

    const timestamp = (dependencies.now ?? (() => new Date()))().getTime();
    const path = (event.rawPath ?? event.routeKey?.split(' ')[1] ?? '/').replace(/^\/internal(?=\/)/, '');
    const ids = reviewedGreenhouseSources.map((source) => source.id);
    const [healthRecords, checkpoints] = await Promise.all([
      dependencies.store.getSourceHealthMany(ids),
      Promise.all(ids.map((sourceId) => dependencies.store.getCheckpoint(sourceId))),
    ]);
    const health = new Map(healthRecords.map((record) => [record.sourceId, record]));
    const rows = reviewedGreenhouseSources.map((source, index) => publicSource(source, health.get(source.id), checkpoints[index], timestamp));

    if (path === '/operations/sources') {
      const fleet = await fleetStatus(
        dependencies.queueUrl,
        dependencies.deadLetterQueueUrl,
        dependencies.sqs ?? new SQSClient({}),
        dependencies.cloudwatch ?? new CloudWatchClient({}),
      );
      const order: Record<SourceHealthState, number> = { quarantined: 0, degraded: 1, 'never-succeeded': 2, healthy: 3 };
      return reply(200, {
        generatedAt: new Date(timestamp).toISOString(),
        sources: rows,
        reliabilityRanking: [...rows].sort((a, b) => order[a.state] - order[b.state] || b.consecutiveFailures - a.consecutiveFailures || a.source.displayName.localeCompare(b.source.displayName)),
        fleet,
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

const tableName = process.env.INTERNSHIPS_TABLE;
const queueUrl = process.env.GREENHOUSE_QUEUE_URL;
const deadLetterQueueUrl = process.env.GREENHOUSE_DEAD_LETTER_QUEUE_URL;
const sharedSecret = process.env.OPERATIONS_SHARED_SECRET;

export const handler = async (event: ApiEvent) => {
  if (!tableName || !queueUrl || !deadLetterQueueUrl || !sharedSecret) {
    return reply(500, { code: 'OPERATIONS_NOT_CONFIGURED', message: 'Source operations data is not configured.' });
  }
  return createGreenhouseOperationsHandler({
    store: new DynamoInternshipStore(tableName),
    queueUrl,
    deadLetterQueueUrl,
    sharedSecret,
  })(event);
};
