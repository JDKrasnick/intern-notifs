import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Internship } from './types.js';

/** Backfill catalog fields after deploying server-side search and source filters. */
async function main() {
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  if (!process.argv.includes('--apply')) throw new Error('Refusing to write without --apply');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  let startKey: Record<string, unknown> | undefined; let updated = 0;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    for (const item of page.Items ?? []) {
      if (!String(item.pk).startsWith('JOB#') || item.sk !== 'META' || !item.job) continue;
      const job = item.job as Internship;
      const searchText = `${job.company} ${job.title} ${job.location}`.toLowerCase();
      const direct = job.sourceReferences.some((reference) => /^(greenhouse|lever|ashby)-/i.test(reference.sourceId));
      const community = job.sourceReferences.some((reference) => /^github-/i.test(reference.sourceId) || /github\.com/i.test(reference.sourceUrl));
      const sourceClasses = ['all', ...(direct ? ['direct'] : []), ...(community ? ['community'] : []), ...(direct && community ? ['corroborated'] : [])];
      await client.send(new UpdateCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: 'SET catalogSearchText = :searchText, catalogSourceClasses = :sourceClasses', ExpressionAttributeValues: { ':searchText': searchText, ':sourceClasses': sourceClasses } }));
      updated += 1;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  console.log(JSON.stringify({ tableName, updated }));
}

void main();
