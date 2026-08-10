import type { SourceCheckpoint, SourceHealth, SourceOccurrenceState, SourceOccurrenceStatus } from '../types.js';

export interface SourceFreshness {
  staleCount: number;
  byProvider: Record<'github' | 'lever' | 'greenhouse' | 'ashby' | 'unknown', number>;
  staleSourceIds: string[];
}

/**
 * Joins an occurrence's durable change facts with the confirmation the source
 * checkpoint already records, so "last changed" and "last confirmed present"
 * are both answerable without writing every occurrence on every poll.
 */
export function occurrenceStatus(
  occurrence: SourceOccurrenceState,
  checkpoint?: SourceCheckpoint,
  health?: SourceHealth,
): SourceOccurrenceStatus {
  const confirmed = Boolean(checkpoint?.activeExternalIds?.includes(occurrence.externalId));
  const confirmedAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  return {
    ...occurrence,
    ...(confirmed && checkpoint?.contentHash ? { confirmedSnapshotHash: checkpoint.contentHash } : {}),
    ...(confirmed && confirmedAt ? { confirmedAt } : {}),
  };
}

/** Source IDs stay in the diagnostic result/logs; metrics consume only `byProvider`. */
export function evaluateSourceFreshness(
  records: SourceHealth[],
  now = new Date(),
  staleAfterMinutes?: number,
): SourceFreshness {
  const stale = records.filter((record) => {
    const allowedMinutes = staleAfterMinutes ?? (record.provider === 'lever' || record.provider === 'greenhouse' ? 90 : 30);
    const cutoff = now.getTime() - allowedMinutes * 60_000;
    return !record.lastSuccessAt || Date.parse(record.lastSuccessAt) < cutoff;
  });
  const byProvider: SourceFreshness['byProvider'] = { github: 0, lever: 0, greenhouse: 0, ashby: 0, unknown: 0 };
  for (const record of stale) byProvider[record.provider ?? 'unknown'] += 1;
  return {
    staleCount: stale.length,
    byProvider,
    staleSourceIds: stale.map((record) => record.sourceId).sort(),
  };
}
