import type { SourceCheckpoint, SourceHealth, SourceOccurrenceState, SourceOccurrenceStatus } from '../types.js';
import { catalogProviderIds, integrationRegistry, isCatalogProviderId } from '../integration-registry.js';

export interface SourceFreshness {
  staleCount: number;
  byProvider: Record<string, number>;
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
    ...(confirmed && confirmedAt ? { lastConfirmedAt: confirmedAt } : {}),
  };
}

/** Source IDs stay in the diagnostic result/logs; metrics consume only `byProvider`. */
export function evaluateSourceFreshness(
  records: SourceHealth[],
  now = new Date(),
  staleAfterMinutes?: number,
): SourceFreshness {
  const stale = records.filter((record) => {
    const provider = record.provider;
    const allowedMinutes = staleAfterMinutes
      ?? (isCatalogProviderId(provider) ? integrationRegistry[provider].freshnessWindowMs / 60_000 : 30);
    const cutoff = now.getTime() - allowedMinutes * 60_000;
    return !record.lastSuccessAt || Date.parse(record.lastSuccessAt) < cutoff;
  });
  const byProvider: SourceFreshness['byProvider'] = Object.fromEntries([...catalogProviderIds, 'unknown'].map((provider) => [provider, 0]));
  for (const record of stale) {
    const recordedProvider = record.provider;
    const provider = isCatalogProviderId(recordedProvider) ? recordedProvider : 'unknown';
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
  }
  return {
    staleCount: stale.length,
    byProvider,
    staleSourceIds: stale.map((record) => record.sourceId).sort(),
  };
}
