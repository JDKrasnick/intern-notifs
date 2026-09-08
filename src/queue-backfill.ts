import type { ApplicationRecord } from './types.js';

/**
 * One-time queue backfill for records saved before `queuedAt` existed.
 * Strict queue membership (`status === 'saved'` with `queuedAt` set) would
 * otherwise hide those roles from the apply queue until re-marked, so the
 * backfill adopts them with `queuedAt` equal to `createdAt`, matching the
 * mobile sort fallback. Records already dequeued on purpose cannot be
 * distinguished after the fact; run this once, before the queue release.
 */
export function needsQueueBackfill(record: ApplicationRecord): boolean {
  return record.status === 'saved' && record.queuedAt === undefined;
}

export function backfilledQueueMembership(record: ApplicationRecord): ApplicationRecord {
  return { ...record, queuedAt: record.createdAt };
}

/** D1 twin of the Dynamo backfill below; run with `wrangler d1 execute --remote`. */
export const QUEUE_BACKFILL_D1_SQL =
  "UPDATE user_items SET value = json_set(value, '$.queuedAt', json_extract(value, '$.createdAt')) " +
  "WHERE kind = 'application' AND json_extract(value, '$.status') = 'saved' AND json_extract(value, '$.queuedAt') IS NULL";
