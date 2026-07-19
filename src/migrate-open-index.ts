import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoInternshipStore } from './store.js';
import type { Internship } from './types.js';

/** One-time, idempotent backfill for the open-jobs GSI introduced for the public feed. */
async function main() {
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({})); const store = new DynamoInternshipStore(tableName, client);
  let startKey: Record<string, unknown> | undefined; let migrated = 0;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    for (const item of page.Items ?? []) {
      const job = item.job as Internship | undefined;
      if (item.pk?.startsWith('JOB#') && job?.open) { await store.putInternship(job); migrated += 1; }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  console.log(JSON.stringify({ tableName, migrated }));
}
void main();
