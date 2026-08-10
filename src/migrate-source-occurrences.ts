import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { normalizeUrl } from './core/normalize.js';
import { DynamoInternshipStore } from './store.js';
import type { Internship, SourceOccurrence } from './types.js';

/**
 * One-time, idempotent backfill that seeds source occurrences from the catalog
 * written before occurrence tracking existed. Without it, a role whose source
 * row disappeared before the first standardized poll would never accrue the two
 * omissions that close it.
 *
 * Identity must match what each connector derives, so ATS references reuse the
 * provider posting ID they stored as `document`, and Markdown references reuse
 * document path plus normalized application URL.
 */
export function backfilledExternalId(reference: SourceOccurrence): string | undefined {
  if (reference.externalId) return reference.externalId;
  if (!reference.document) return undefined;
  if (/^(?:shadow-)?(?:lever|greenhouse)-/.test(reference.sourceId)) return reference.document;
  try { return `${reference.document}:${normalizeUrl(reference.applyUrl)}`; }
  catch { return undefined; }
}

async function main() {
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  // `--dry-run` reports exactly what a real run would seed, so the backfill can
  // be inspected against production before it writes anything.
  const dryRun = process.argv.includes('--dry-run');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = new DynamoInternshipStore(tableName, client);
  const existing = new Map<string, Set<string>>();
  const seededAt = new Date().toISOString();
  let startKey: Record<string, unknown> | undefined;
  const bySource = new Map<string, number>();
  let seeded = 0;
  let skipped = 0;
  let unidentifiable = 0;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    for (const item of page.Items ?? []) {
      const job = item.job as Internship | undefined;
      if (!item.pk?.startsWith('JOB#') || !job) continue;
      for (const reference of job.sourceReferences) {
        const externalId = backfilledExternalId(reference);
        if (!externalId) { unidentifiable += 1; continue; }
        if (!existing.has(reference.sourceId)) {
          existing.set(reference.sourceId, new Set((await store.getSourceOccurrences(reference.sourceId)).map((value) => value.externalId)));
        }
        const known = existing.get(reference.sourceId)!;
        if (known.has(externalId)) { skipped += 1; continue; }
        const checkpoint = await store.getCheckpoint(reference.sourceId);
        bySource.set(reference.sourceId, (bySource.get(reference.sourceId) ?? 0) + 1);
        if (dryRun) { known.add(externalId); seeded += 1; continue; }
        await store.putSourceOccurrence({
          sourceId: reference.sourceId,
          externalId,
          jobId: job.jobId,
          occurrence: { ...reference, externalId },
          // The next poll decides presence; a role the source dropped starts its
          // omission streak then instead of closing on backfilled belief.
          present: true,
          consecutiveOmissions: 0,
          changedSnapshotHash: checkpoint?.contentHash ?? 'backfill',
          changedAt: seededAt,
          // Catalog records do not retain the original source discovery time.
          // Mark it unknown rather than treating the migration clock as history.
          firstObservedAtPrecision: 'unknown',
        });
        known.add(externalId);
        seeded += 1;
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  console.log(JSON.stringify({ tableName, dryRun, seeded, skipped, unidentifiable, bySource: Object.fromEntries([...bySource].sort()) }));
}

if (process.argv[1]?.endsWith('migrate-source-occurrences.ts')) void main();
