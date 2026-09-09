import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { backfilledQueueMembership, needsQueueBackfill, QUEUE_BACKFILL_D1_SQL } from '../src/queue-backfill.js';
import type { ApplicationRecord } from '../src/types.js';

function option(name: string) { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; }

async function main() {
  if (process.argv.includes('--d1-sql')) {
    console.log(QUEUE_BACKFILL_D1_SQL + ';');
    console.log('-- Run with: wrangler d1 execute --remote --command "<sql>"');
    return;
  }
  const usersTable = option('--users-table') ?? process.env.USERS_TABLE;
  if (!usersTable) throw new Error('Pass --users-table or set USERS_TABLE');
  const apply = process.argv.includes('--apply');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  let cursor: Record<string, unknown> | undefined;
  let candidates = 0; let updated = 0;
  do {
    const result = await client.send(new ScanCommand({
      TableName: usersTable,
      FilterExpression: '#kind = :application',
      ProjectionExpression: 'pk, sk, #kind, #value',
      ExpressionAttributeNames: { '#kind': 'kind', '#value': 'value' },
      ExpressionAttributeValues: { ':application': 'application' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of result.Items ?? []) {
      const record = (item as { value: ApplicationRecord }).value;
      if (!needsQueueBackfill(record)) continue;
      candidates += 1;
      if (!apply) {
        console.log(`would backfill ${item.pk} ${item.sk} queuedAt=${record.createdAt}`);
        continue;
      }
      await client.send(new PutCommand({
        TableName: usersTable,
        Item: { ...item, value: backfilledQueueMembership(record) },
      }));
      updated += 1;
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  console.log(apply ? `backfilled ${updated} of ${candidates} saved applications` : `dry run: ${candidates} saved applications need queuedAt (pass --apply)`);
}

void main();
