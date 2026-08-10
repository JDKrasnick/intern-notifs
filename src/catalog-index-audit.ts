import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isTechnicalJob } from './core/filters.js';
import type { Internship } from './types.js';

export type CatalogIndexMismatchKind = 'openTechnical' | 'closedTechnical' | 'nontechnical';

export interface CatalogIndexItem {
  pk?: string;
  sk?: string;
  openPk?: string;
  openSk?: string;
  closedPk?: string;
  closedSk?: string;
  job?: Internship;
}

export interface CatalogIndexAuditReport {
  scannedItems: number;
  jobs: number;
  mismatches: number;
  byKind: Record<CatalogIndexMismatchKind, number>;
  affectedJobIds?: Record<CatalogIndexMismatchKind, string[]>;
  repairToken: string;
  repaired: number;
}

interface AffectedCatalogIndexItem {
  item: CatalogIndexItem & { job: Internship };
  job: Internship;
  kind: CatalogIndexMismatchKind;
}

export function canonicalCatalogJob(job: Internship): Internship {
  return job.technical === undefined ? { ...job, technical: isTechnicalJob(job) } : job;
}

export function catalogIndexMismatch(item: CatalogIndexItem): CatalogIndexMismatchKind | undefined {
  if (!item.pk?.startsWith('JOB#') || item.sk !== 'META' || !item.job) return undefined;
  const job = canonicalCatalogJob(item.job);
  const noOpenIndex = item.openPk === undefined && item.openSk === undefined;
  const noClosedIndex = item.closedPk === undefined && item.closedSk === undefined;
  if (job.technical === false) return noOpenIndex && noClosedIndex ? undefined : 'nontechnical';
  if (job.open) {
    return item.openPk === 'OPEN' && item.openSk === `${job.firstSeenAt}#${job.jobId}` && noClosedIndex
      ? undefined : 'openTechnical';
  }
  return item.closedPk === 'CLOSED' && item.closedSk === `${job.lastSeenAt}#${job.jobId}` && noOpenIndex
    ? undefined : 'closedTechnical';
}

function catalogIndexRepairToken(affected: AffectedCatalogIndexItem[]): string {
  const entries = affected.map(({ item, kind }) => ({
    kind,
    jobId: item.job.jobId,
    company: item.job.company,
    title: item.job.title,
    location: item.job.location,
    season: item.job.season,
    technical: item.job.technical ?? null,
    open: item.job.open,
    firstSeenAt: item.job.firstSeenAt,
    lastSeenAt: item.job.lastSeenAt,
    openPk: item.openPk ?? null,
    openSk: item.openSk ?? null,
    closedPk: item.closedPk ?? null,
    closedSk: item.closedSk ?? null,
  })).sort((left, right) => left.jobId.localeCompare(right.jobId));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function repairCatalogIndexItem(
  tableName: string,
  client: DynamoDBDocumentClient,
  affected: AffectedCatalogIndexItem,
): Promise<void> {
  const { item, job } = affected;
  const names: Record<string, string> = {
    '#job': 'job', '#jobId': 'jobId', '#open': 'open', '#firstSeenAt': 'firstSeenAt', '#lastSeenAt': 'lastSeenAt',
    '#openPk': 'openPk', '#openSk': 'openSk', '#closedPk': 'closedPk', '#closedSk': 'closedSk',
  };
  const values: Record<string, unknown> = {
    ':jobId': item.job.jobId, ':open': item.job.open,
    ':firstSeenAt': item.job.firstSeenAt, ':lastSeenAt': item.job.lastSeenAt,
  };
  const conditions = [
    '#job.#jobId = :jobId', '#job.#open = :open',
    '#job.#firstSeenAt = :firstSeenAt', '#job.#lastSeenAt = :lastSeenAt',
  ];
  const set: string[] = [];
  const remove: string[] = [];

  names['#technical'] = 'technical';
  if (item.job.technical === undefined) {
    Object.assign(names, { '#company': 'company', '#title': 'title', '#location': 'location', '#season': 'season' });
    Object.assign(values, {
      ':company': item.job.company, ':title': item.job.title,
      ':location': item.job.location, ':season': item.job.season,
      ':technical': job.technical,
    });
    conditions.push(
      'attribute_not_exists(#job.#technical)', '#job.#company = :company', '#job.#title = :title',
      '#job.#location = :location', '#job.#season = :season',
    );
    set.push('#job.#technical = :technical');
  } else {
    values[':technical'] = item.job.technical;
    conditions.push('#job.#technical = :technical');
  }

  if (job.technical === false) {
    remove.push('#openPk', '#openSk', '#closedPk', '#closedSk');
  } else if (job.open) {
    Object.assign(values, { ':indexPk': 'OPEN', ':indexSk': `${job.firstSeenAt}#${job.jobId}` });
    set.push('#openPk = :indexPk', '#openSk = :indexSk');
    remove.push('#closedPk', '#closedSk');
  } else {
    Object.assign(values, { ':indexPk': 'CLOSED', ':indexSk': `${job.lastSeenAt}#${job.jobId}` });
    set.push('#closedPk = :indexPk', '#closedSk = :indexSk');
    remove.push('#openPk', '#openSk');
  }

  await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: [...(set.length ? [`SET ${set.join(', ')}`] : []), `REMOVE ${remove.join(', ')}`].join(' '),
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export async function auditCatalogIndexes(
  tableName: string,
  client: DynamoDBDocumentClient,
  options: { repair?: boolean; expectedMismatches?: number; expectedRepairToken?: string; includeJobIds?: boolean } = {},
): Promise<CatalogIndexAuditReport> {
  const report: CatalogIndexAuditReport = {
    scannedItems: 0, jobs: 0, mismatches: 0,
    byKind: { openTechnical: 0, closedTechnical: 0, nontechnical: 0 }, repairToken: '', repaired: 0,
  };
  if (options.includeJobIds) report.affectedJobIds = { openTechnical: [], closedTechnical: [], nontechnical: [] };
  const affected: AffectedCatalogIndexItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: tableName,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    report.scannedItems += page.Items?.length ?? 0;
    for (const rawItem of page.Items ?? []) {
      const item = rawItem as CatalogIndexItem;
      if (!item.pk?.startsWith('JOB#') || item.sk !== 'META' || !item.job) continue;
      report.jobs += 1;
      const kind = catalogIndexMismatch(item);
      if (!kind) continue;
      report.mismatches += 1;
      report.byKind[kind] += 1;
      report.affectedJobIds?.[kind].push(item.job.jobId);
      affected.push({ item: item as CatalogIndexItem & { job: Internship }, job: canonicalCatalogJob(item.job), kind });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  report.repairToken = catalogIndexRepairToken(affected);

  if (!options.repair) return report;
  if (options.expectedMismatches === undefined) throw new Error('Repair requires expectedMismatches from a preceding dry-run');
  if (!options.expectedRepairToken) throw new Error('Repair requires expectedRepairToken from a preceding dry-run');
  if (report.mismatches !== options.expectedMismatches) {
    throw new Error(`Refusing repair: expected ${options.expectedMismatches} mismatches but found ${report.mismatches}`);
  }
  if (report.repairToken !== options.expectedRepairToken) {
    throw new Error(`Refusing repair: expected repair token ${options.expectedRepairToken} but found ${report.repairToken}`);
  }
  for (const item of affected) {
    await repairCatalogIndexItem(tableName, client, item);
    report.repaired += 1;
  }
  return report;
}

/** CloudWatch Embedded Metric Format; the scheduled audit alarm consumes this log event. */
export function emitCatalogIndexAuditMetric(report: CatalogIndexAuditReport, timestamp = Date.now()): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Catalog', Dimensions: [['Service']],
        Metrics: [{ Name: 'CatalogIndexMismatchCount', Unit: 'Count' }],
      }],
    },
    Service: 'catalog', CatalogIndexMismatchCount: report.mismatches,
    CatalogIndexJobsScanned: report.jobs, CatalogIndexMismatchKinds: report.byKind,
  }));
}
