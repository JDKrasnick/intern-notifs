import type { SourceHealth } from '../types.js';

export interface SourceFreshness {
  staleCount: number;
  byProvider: Record<SourceHealth['provider'], number>;
  staleSourceIds: string[];
}

/** Source IDs stay in the diagnostic result/logs; metrics consume only `byProvider`. */
export function evaluateSourceFreshness(
  records: SourceHealth[],
  now = new Date(),
  staleAfterMinutes = 30,
): SourceFreshness {
  const cutoff = now.getTime() - staleAfterMinutes * 60_000;
  const stale = records.filter((record) => !record.lastSuccessAt || Date.parse(record.lastSuccessAt) < cutoff);
  const byProvider: SourceFreshness['byProvider'] = { github: 0, lever: 0, greenhouse: 0, unknown: 0 };
  for (const record of stale) byProvider[record.provider] += 1;
  return {
    staleCount: stale.length,
    byProvider,
    staleSourceIds: stale.map((record) => record.sourceId).sort(),
  };
}
