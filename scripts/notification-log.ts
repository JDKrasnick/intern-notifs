import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { buildNotificationLog } from '../src/notification-log.js';
import type { DeliveryReceipt, Internship } from '../src/types.js';

function option(name: string) { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; }
function positiveInteger(value: string | undefined) { if (!value) return undefined; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('--limit must be a positive integer'); return parsed; }

async function scanReceipts(client: DynamoDBDocumentClient, tableName: string) {
  const receipts: DeliveryReceipt[] = []; let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: '#kind = :receipt',
      ProjectionExpression: '#value',
      ExpressionAttributeNames: { '#kind': 'kind', '#value': 'value' },
      ExpressionAttributeValues: { ':receipt': 'receipt' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    receipts.push(...(result.Items ?? []).map((item) => item.value as DeliveryReceipt)); cursor = result.LastEvaluatedKey;
  } while (cursor);
  return receipts;
}

async function loadJobs(client: DynamoDBDocumentClient, tableName: string, jobIds: string[]) {
  const jobs: Internship[] = [];
  for (let index = 0; index < jobIds.length; index += 100) {
    let keys = jobIds.slice(index, index + 100).map((jobId) => ({ pk: `JOB#${jobId}`, sk: 'META' }));
    do {
      const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ProjectionExpression: '#job', ExpressionAttributeNames: { '#job': 'job' } } } }));
      jobs.push(...(result.Responses?.[tableName] ?? []).map((item) => item.job as Internship));
      keys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
    } while (keys.length);
  }
  return jobs;
}

async function main() {
  const usersTable = option('--users-table') ?? process.env.USERS_TABLE;
  const internshipsTable = option('--internships-table') ?? process.env.INTERNSHIPS_TABLE;
  if (!usersTable || !internshipsTable) throw new Error('Set USERS_TABLE and INTERNSHIPS_TABLE, or pass --users-table and --internships-table.');
  const since = option('--since') ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (Number.isNaN(Date.parse(since))) throw new Error('--since must be an ISO-8601 timestamp');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const receipts = await scanReceipts(client, usersTable);
  const relevant = receipts.filter((receipt) => receipt.createdAt >= since);
  const jobs = await loadJobs(client, internshipsTable, [...new Set(relevant.map((receipt) => receipt.jobId))]);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), since, company: option('--company'), ...buildNotificationLog(relevant, jobs, { since, company: option('--company'), limit: positiveInteger(option('--limit')) }) }, null, 2));
}

void main();
