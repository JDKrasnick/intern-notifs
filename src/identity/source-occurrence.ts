import type { SourceOccurrence } from '../types.js';

/**
 * Source occurrences are durably stored by source and external ID. Document
 * coordinates are only identity for legacy references that predate external
 * IDs; rows can move whenever an upstream document is edited.
 */
export function sourceOccurrenceKey(value: SourceOccurrence): string {
  return value.externalId
    ? [value.sourceId, 'external', value.externalId].join('\0')
    : [value.sourceId, 'legacy-location', value.document ?? '', value.row ?? ''].join('\0');
}

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

export function mergeSourceOccurrence(
  previous: SourceOccurrence | undefined,
  incoming: SourceOccurrence,
): SourceOccurrence {
  const firstAttachedAt = earliest([previous?.firstAttachedAt, incoming.firstAttachedAt]);
  const providerEvidence = previous?.providerEvidence && incoming.providerEvidence
    ? {
        ...previous.providerEvidence,
        ...incoming.providerEvidence,
        urls: [...new Set([...previous.providerEvidence.urls, ...incoming.providerEvidence.urls])].sort(),
      }
    : incoming.providerEvidence ?? previous?.providerEvidence;
  const provenance = incoming.provenance ?? previous?.provenance;
  return {
    ...previous,
    ...incoming,
    ...(provenance ? { provenance } : {}),
    ...(providerEvidence ? { providerEvidence } : {}),
    ...(firstAttachedAt ? { firstAttachedAt } : {}),
    ...(previous?.firstAttachedAtPrecision === 'exact' || incoming.firstAttachedAtPrecision === 'exact'
      ? { firstAttachedAtPrecision: 'exact' as const }
      : previous?.firstAttachedAtPrecision || incoming.firstAttachedAtPrecision
        ? { firstAttachedAtPrecision: 'unknown' as const }
        : {}),
  };
}

export function mergeSourceOccurrenceReferences(values: SourceOccurrence[]): SourceOccurrence[] {
  const merged = new Map<string, SourceOccurrence>();
  for (const occurrence of values) {
    const key = sourceOccurrenceKey(occurrence);
    merged.set(key, mergeSourceOccurrence(merged.get(key), occurrence));
  }
  return [...merged.values()];
}
