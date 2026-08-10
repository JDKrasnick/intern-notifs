import type { SourceCheckpoint, SourceHealth } from './types.js';

/** The single cadence contract used by provider dispatchers and their stacks. */
export const SOURCE_POLL_CADENCE = {
  activeIntervalMs: 60 * 60 * 1000,
  quietIntervalMs: 6 * 60 * 60 * 1000,
  schedules: {
    greenhouse: 'cron(12 * * * ? *)',
    lever: 'cron(22 * * * ? *)',
    ashby: 'cron(32 * * * ? *)',
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
 * Quiet sources use the last completed attempt when available, falling back to
 * their last trusted snapshot. This makes a delayed or missed hourly run catch
 * up instead of requiring the scheduler to hit a particular modulo window.
 */
export function isQuietSourceDue(
  sourceId: string,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  const lastPollAt = timestamp(health?.lastAttemptAt)
    ?? timestamp(health?.lastSuccessAt)
    ?? timestamp(checkpoint?.lastSuccessAt);
  if (lastPollAt !== undefined) return now.getTime() - lastPollAt >= SOURCE_POLL_CADENCE.quietIntervalMs;

  // A source with state but no usable timestamp must recover immediately. Only
  // brand-new quiet sources are spread across the first six hourly runs.
  if (checkpoint || health) return true;
  const buckets = SOURCE_POLL_CADENCE.quietIntervalMs / SOURCE_POLL_CADENCE.activeIntervalMs;
  const currentWindow = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.activeIntervalMs);
  return currentWindow % buckets === stableSourceBucket(sourceId, buckets);
}

export function isProviderSourceDue(
  sourceId: string,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  if (health?.sourceStatus === 'paused') return false;
  const backoffUntil = timestamp(health?.backoffUntil);
  if (backoffUntil !== undefined && backoffUntil > now.getTime()) return false;
  if (health?.pollTier !== 'quiet' && (!checkpoint || (checkpoint.lastRowCount ?? 0) > 0)) return true;
  return isQuietSourceDue(sourceId, checkpoint, now, health);
}
