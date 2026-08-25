import type { Queue } from './types.js';

export async function queueHasBacklog(queue: Queue, name: string): Promise<boolean> {
  if (!queue.metrics) return false;
  try {
    const metrics = await queue.metrics();
    if (metrics.backlogCount <= 0) return false;
    console.log(JSON.stringify({ event: 'scheduled_dispatch_skipped', queue: name, backlogCount: metrics.backlogCount }));
    return true;
  } catch (error) {
    // Queue metrics are best-effort. Fail open so an observability outage does
    // not silently stop ingestion.
    console.warn(JSON.stringify({ event: 'queue_metrics_failed', queue: name, error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}
