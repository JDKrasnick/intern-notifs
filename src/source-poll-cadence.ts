import type { SourceCheckpoint, SourceHealth } from './types.js';

/** The single cadence contract used by provider dispatchers and their stacks. */
export const SOURCE_POLL_CADENCE = {
  publishedIntervalMs: 30 * 60 * 1000,
  shadowIntervalMs: 3 * 60 * 60 * 1000,
  // With the current account concurrency quota of 10, three provider fleets
  // can use at most six worker executions and leave capacity for the public API.
  workerMaxConcurrency: 2,
  schedules: {
    github: 'cron(7/10 * * * ? *)',
    greenhouse: 'cron(12,42 * * * ? *)',
    lever: 'cron(22,52 * * * ? *)',
    ashby: 'cron(2,32 * * * ? *)',
  },
} as const;

function stableSourceBucket(sourceId: string, buckets: number): number {
  let hash = 2166136261;
  for (const character of sourceId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % buckets;
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Shadow sources use the last completed attempt when available, falling back
 * to their last trusted snapshot. This makes a delayed or missed scheduler run
 * catch up instead of requiring an exact modulo window.
 */
function isShadowSourceDue(
  sourceId: string,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  const lastPollAt = timestamp(health?.lastAttemptAt)
    ?? timestamp(health?.lastSuccessAt)
    ?? timestamp(checkpoint?.lastSuccessAt);
  if (lastPollAt !== undefined) {
    // Workers record completion slightly after the dispatcher invocation.
    // Compare scheduler windows so normal processing latency does not defer a
    // three-hour poll to the following half-hour run.
    const elapsedWindows = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.publishedIntervalMs)
      - Math.floor(lastPollAt / SOURCE_POLL_CADENCE.publishedIntervalMs);
    return elapsedWindows >= SOURCE_POLL_CADENCE.shadowIntervalMs / SOURCE_POLL_CADENCE.publishedIntervalMs;
  }

  // A source with state but no usable timestamp must recover immediately. Only
  // brand-new shadow sources are spread across the first six dispatcher runs.
  if (checkpoint || health) return true;
  const buckets = SOURCE_POLL_CADENCE.shadowIntervalMs / SOURCE_POLL_CADENCE.publishedIntervalMs;
  const currentWindow = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.publishedIntervalMs);
  return currentWindow % buckets === stableSourceBucket(sourceId, buckets);
}

export function isProviderSourceDue(
  sourceId: string,
  sourceStatus: 'published' | 'shadow',
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  if (health?.sourceStatus === 'paused') return false;
  const backoffUntil = timestamp(health?.backoffUntil);
  if (backoffUntil !== undefined && backoffUntil > now.getTime()) return false;
  if (sourceStatus === 'published') return true;
  return isShadowSourceDue(sourceId, checkpoint, now, health);
}
