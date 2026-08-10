import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { auditCatalogIndexes } from './catalog-index-audit.js';

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

/** Dry-run by default; repair requires the observed mismatch count as a guardrail. */
async function main() {
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  const repair = process.argv.includes('--repair');
  const expectedMismatches = integerOption('--expected-mismatches');
  const expectedRepairToken = stringOption('--expected-repair-token');
  if (repair && (expectedMismatches === undefined || !expectedRepairToken)) {
    throw new Error('--repair requires --expected-mismatches and --expected-repair-token from a preceding dry-run');
  }
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const report = await auditCatalogIndexes(tableName, client, { repair, expectedMismatches, expectedRepairToken, includeJobIds: true });
  console.log(JSON.stringify({ tableName, mode: repair ? 'repair' : 'dry-run', ...report }));
}

void main();
