import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isTechnicalJob } from './core/filters.js';
import { DynamoInternshipStore } from './store.js';
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
  repaired: number;
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

export async function auditCatalogIndexes(
  tableName: string,
  client: DynamoDBDocumentClient,
  options: { repair?: boolean; expectedMismatches?: number; includeJobIds?: boolean } = {},
): Promise<CatalogIndexAuditReport> {
  const report: CatalogIndexAuditReport = {
    scannedItems: 0, jobs: 0, mismatches: 0,
    byKind: { openTechnical: 0, closedTechnical: 0, nontechnical: 0 }, repaired: 0,
  };
  if (options.includeJobIds) report.affectedJobIds = { openTechnical: [], closedTechnical: [], nontechnical: [] };
  const affected: Internship[] = [];
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
      affected.push(canonicalCatalogJob(item.job));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  if (!options.repair) return report;
  if (options.expectedMismatches === undefined) throw new Error('Repair requires expectedMismatches from a preceding dry-run');
  if (report.mismatches !== options.expectedMismatches) {
    throw new Error(`Refusing repair: expected ${options.expectedMismatches} mismatches but found ${report.mismatches}`);
  }
  const store = new DynamoInternshipStore(tableName, client);
  for (const job of affected) {
    await store.putInternship(job);
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
