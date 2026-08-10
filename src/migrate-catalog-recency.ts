import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoDocumentClient } from './store.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { reviewedAshbySources } from './sources/ashby-config.js';
import type { Internship } from './types.js';

export interface CatalogRecencyMigrationItem {
  pk?: string;
  sk?: string;
  openPk?: string;
  openSk?: string;
  closedPk?: string;
  closedSk?: string;
  job?: Internship;
}

interface Candidate {
  item: CatalogRecencyMigrationItem & { pk: string; sk: string; job: Internship };
  sourceId: string;
}

export interface CatalogRecencyMigrationReport {
  scannedItems: number;
  jobs: number;
  candidates: number;
  candidateJobIds: string[];
  repairToken: string;
  repaired: number;
}

export interface CatalogRecencyMigrationOptions {
  apply?: boolean;
  expectedCount?: number;
  expectedRepairToken?: string;
  /** Optional operator-reviewed subset from a preceding unrestricted dry run. */
  candidateJobIds?: readonly string[];
}

const ASHBY_BASELINE_DATE = '2026-08-09';
const CONFIRMED_ASHBY_SOURCE_IDS = new Set(reviewedAshbySources.map((source) => source.id));

/** Select only jobs whose canonical row was created by the affected Ashby baseline. */
export function ashbyBaselineCandidate(item: CatalogRecencyMigrationItem): Candidate | undefined {
  const job = item.job;
  if (!item.pk?.startsWith('JOB#') || item.sk !== 'META' || !job) return undefined;
  if (job.catalogRecency === 'baseline' || !job.firstSeenAt.startsWith(ASHBY_BASELINE_DATE)) return undefined;
  if (job.notification.smsPending || job.notification.digestPending || job.notification.smsSentAt || job.notification.digestedAt) return undefined;
  const firstReference = job.sourceReferences[0];
  if (!firstReference || !CONFIRMED_ASHBY_SOURCE_IDS.has(firstReference.sourceId)) return undefined;
  if (firstReference.firstAttachedAt !== job.firstSeenAt || firstReference.firstAttachedAtPrecision !== 'exact') return undefined;
  return { item: item as Candidate['item'], sourceId: firstReference.sourceId };
}

function repairToken(candidates: Candidate[]): string {
  const facts = candidates.map(({ item, sourceId }) => ({
    jobId: item.job.jobId,
    sourceId,
    firstSeenAt: item.job.firstSeenAt,
    lastSeenAt: item.job.lastSeenAt,
    open: item.job.open,
    technical: item.job.technical ?? null,
    catalogVisibleAt: item.job.catalogVisibleAt ?? null,
    catalogRecency: item.job.catalogRecency ?? null,
    openPk: item.openPk ?? null,
    openSk: item.openSk ?? null,
    closedPk: item.closedPk ?? null,
    closedSk: item.closedSk ?? null,
  })).sort((left, right) => left.jobId.localeCompare(right.jobId));
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

async function repairCandidate(tableName: string, client: DynamoDBDocumentClient, candidate: Candidate): Promise<void> {
  const { item } = candidate;
  const baseline = { ...item.job, catalogVisibleAt: item.job.catalogVisibleAt ?? item.job.firstSeenAt, catalogRecency: 'baseline' as const };
  const names: Record<string, string> = {
    '#job': 'job', '#jobId': 'jobId', '#firstSeenAt': 'firstSeenAt', '#lastSeenAt': 'lastSeenAt',
    '#sourceReferences': 'sourceReferences', '#notification': 'notification', '#catalogVisibleAt': 'catalogVisibleAt',
    '#catalogRecency': 'catalogRecency',
  };
  const values: Record<string, unknown> = {
    ':jobId': item.job.jobId, ':firstSeenAt': item.job.firstSeenAt, ':lastSeenAt': item.job.lastSeenAt,
    ':sourceReferences': item.job.sourceReferences, ':notification': item.job.notification,
    ':catalogVisibleAt': baseline.catalogVisibleAt, ':catalogRecency': 'baseline',
  };
  const conditions = [
    '#job.#jobId = :jobId', '#job.#firstSeenAt = :firstSeenAt', '#job.#lastSeenAt = :lastSeenAt',
    '#job.#sourceReferences = :sourceReferences', '#job.#notification = :notification',
  ];
  const set = ['#job.#catalogVisibleAt = :catalogVisibleAt', '#job.#catalogRecency = :catalogRecency'];
  const remove: string[] = [];
  if (item.job.catalogVisibleAt === undefined) conditions.push('attribute_not_exists(#job.#catalogVisibleAt)');
  else conditions.push('#job.#catalogVisibleAt = :catalogVisibleAt');
  if (item.job.catalogRecency === undefined) conditions.push('attribute_not_exists(#job.#catalogRecency)');
  else {
    values[':oldCatalogRecency'] = item.job.catalogRecency;
    conditions.push('#job.#catalogRecency = :oldCatalogRecency');
  }
  if (item.job.technical !== false && item.job.open) {
    Object.assign(names, { '#openPk': 'openPk', '#openSk': 'openSk', '#closedPk': 'closedPk', '#closedSk': 'closedSk' });
    Object.assign(values, { ':openPk': 'OPEN', ':openSk': openCatalogSortKey(baseline) });
    set.push('#openPk = :openPk', '#openSk = :openSk');
    remove.push('#closedPk', '#closedSk');
  } else if (item.job.technical !== false) {
    Object.assign(names, { '#openPk': 'openPk', '#openSk': 'openSk' });
    remove.push('#openPk', '#openSk');
  } else {
    Object.assign(names, { '#openPk': 'openPk', '#openSk': 'openSk', '#closedPk': 'closedPk', '#closedSk': 'closedSk' });
    remove.push('#openPk', '#openSk', '#closedPk', '#closedSk');
  }
  await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: [`SET ${set.join(', ')}`, ...(remove.length ? [`REMOVE ${remove.join(', ')}`] : [])].join(' '),
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export async function migrateCatalogRecency(
  tableName: string,
  client: DynamoDBDocumentClient,
  options: CatalogRecencyMigrationOptions = {},
): Promise<CatalogRecencyMigrationReport> {
  const discoveredCandidates: Candidate[] = [];
  let scannedItems = 0;
  let jobs = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    scannedItems += page.Items?.length ?? 0;
    for (const raw of page.Items ?? []) {
      const item = raw as CatalogRecencyMigrationItem;
      if (item.pk?.startsWith('JOB#') && item.sk === 'META' && item.job) jobs += 1;
      const candidate = ashbyBaselineCandidate(item);
      if (candidate) discoveredCandidates.push(candidate);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  const requestedJobIds = options.candidateJobIds && new Set(options.candidateJobIds);
  if (requestedJobIds?.size !== options.candidateJobIds?.length) throw new Error('candidateJobIds must not contain duplicates');
  const discoveredJobIds = new Set(discoveredCandidates.map(({ item }) => item.job.jobId));
  const missingJobIds = [...(requestedJobIds ?? [])].filter((jobId) => !discoveredJobIds.has(jobId)).sort();
  if (missingJobIds.length) throw new Error(`Requested candidate job IDs were not found: ${missingJobIds.join(', ')}`);
  const candidates = requestedJobIds
    ? discoveredCandidates.filter(({ item }) => requestedJobIds.has(item.job.jobId))
    : discoveredCandidates;
  const token = repairToken(candidates);
  const report: CatalogRecencyMigrationReport = {
    scannedItems, jobs, candidates: candidates.length,
    candidateJobIds: candidates.map(({ item }) => item.job.jobId).sort(),
    repairToken: token, repaired: 0,
  };
  if (!options.apply) return report;
  if (options.expectedCount === undefined || !options.expectedRepairToken) {
    throw new Error('Apply requires expectedCount and expectedRepairToken from a preceding dry-run');
  }
  if (candidates.length !== options.expectedCount) throw new Error(`Refusing apply: expected ${options.expectedCount} candidates but found ${candidates.length}`);
  if (token !== options.expectedRepairToken) throw new Error(`Refusing apply: expected repair token ${options.expectedRepairToken} but found ${token}`);
  for (const candidate of candidates) {
    await repairCandidate(tableName, client, candidate);
    report.repaired += 1;
  }
  return report;
}

function integerOption(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} requires a non-negative integer`);
  return value;
}

function stringOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function repeatedStringOption(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

async function main(): Promise<void> {
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  const apply = process.argv.includes('--apply');
  const expectedCount = integerOption('--expected-count');
  const expectedRepairToken = stringOption('--expected-repair-token');
  const candidateJobIds = repeatedStringOption('--candidate-job-id');
  if (apply && (expectedCount === undefined || !expectedRepairToken)) {
    throw new Error('--apply requires --expected-count and --expected-repair-token from a preceding dry-run');
  }
  const report = await migrateCatalogRecency(tableName, createDynamoDocumentClient(new DynamoDBClient({})), {
    apply, expectedCount, expectedRepairToken,
    ...(candidateJobIds.length ? { candidateJobIds } : {}),
  });
  console.log(JSON.stringify({ tableName, mode: apply ? 'apply' : 'dry-run', ...report }));
}

if (process.argv[1]?.endsWith('migrate-catalog-recency.ts')) void main();
