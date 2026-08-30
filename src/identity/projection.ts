import { canonicalCatalogRecency } from '../catalog-recency.js';
import { deriveCanonicalAdmission } from '../catalog-admission.js';
import { isPastSeason } from '../core/early-career.js';
import { isOfficialOccurrence } from '../sources/provenance.js';
import type { Internship, SourceOccurrence, SourceOccurrenceState } from '../types.js';

function occurrenceKey(value: SourceOccurrence): string {
  return [value.sourceId, value.externalId ?? '', value.document ?? '', value.row ?? ''].join('\0');
}

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

function latest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function mergeOccurrence(previous: SourceOccurrence | undefined, incoming: SourceOccurrence): SourceOccurrence {
  const firstAttachedAt = earliest([previous?.firstAttachedAt, incoming.firstAttachedAt]);
  const providerEvidence = previous?.providerEvidence && incoming.providerEvidence
    ? {
        ...previous.providerEvidence,
        ...incoming.providerEvidence,
        urls: [...new Set([...previous.providerEvidence.urls, ...incoming.providerEvidence.urls])].sort(),
      }
    : incoming.providerEvidence ?? previous?.providerEvidence;
  return {
    ...previous,
    ...incoming,
    ...(providerEvidence ? { providerEvidence } : {}),
    ...(firstAttachedAt ? { firstAttachedAt } : {}),
    ...(previous?.firstAttachedAtPrecision === 'exact' || incoming.firstAttachedAtPrecision === 'exact'
      ? { firstAttachedAtPrecision: 'exact' as const }
      : previous?.firstAttachedAtPrecision || incoming.firstAttachedAtPrecision
        ? { firstAttachedAtPrecision: 'unknown' as const }
        : {}),
  };
}

function mergeReferences(current: Internship | undefined, proposed: Internship, occurrence: SourceOccurrenceState): SourceOccurrence[] {
  const references = new Map<string, SourceOccurrence>();
  for (const reference of [...(current?.sourceReferences ?? []), ...proposed.sourceReferences, occurrence.occurrence]) {
    const key = occurrenceKey(reference);
    references.set(key, mergeOccurrence(references.get(key), reference));
  }
  return [...references.values()].sort((left, right) =>
    (left.firstAttachedAt ?? '').localeCompare(right.firstAttachedAt ?? '')
    || occurrenceKey(left).localeCompare(occurrenceKey(right)));
}

export function postingIdentityStatusForOccurrences(references: SourceOccurrence[]): Internship['postingIdentityStatus'] {
  if (references.some((reference) => reference.postingIdentityDecision?.status === 'confirmed')) return 'confirmed';
  if (references.some((reference) => reference.postingIdentityDecision?.status === 'unconfirmed')) return 'unconfirmed';
  return undefined;
}

function presentationOwner(current: Internship | undefined, proposed: Internship): Internship {
  if (!current) return proposed;
  const officialKey = (job: Internship) => job.sourceReferences
    .filter(isOfficialOccurrence)
    .map(occurrenceKey)
    .sort()[0];
  const currentOfficial = officialKey(current);
  const proposedOfficial = officialKey(proposed);
  if (currentOfficial || proposedOfficial) {
    if (!currentOfficial) return proposed;
    if (!proposedOfficial) return current;
    return proposedOfficial.localeCompare(currentOfficial) < 0 ? proposed : current;
  }
  const currentFirst = current.catalogVisibleAt ?? current.firstSeenAt;
  const proposedFirst = proposed.catalogVisibleAt ?? proposed.firstSeenAt;
  return proposedFirst.localeCompare(currentFirst) < 0 ? proposed : current;
}

/**
 * Builds the canonical job projection from durable occurrence facts. The
 * compare-and-swap store implementations call this again after contention, so
 * a concurrent writer cannot erase source history or reset alert tombstones.
 */
export function postingObservationProjection(
  current: Internship | undefined,
  proposed: Internship,
  occurrence: SourceOccurrenceState,
): Internship {
  const sourceReferences = mergeReferences(current, proposed, occurrence);
  const presentation = presentationOwner(current, proposed);
  const admission = deriveCanonicalAdmission(sourceReferences, latest([current?.lastSeenAt, proposed.lastSeenAt]) ?? proposed.lastSeenAt);
  const smsSentAt = latest([current?.notification.smsSentAt, proposed.notification.smsSentAt]);
  const digestedAt = latest([current?.notification.digestedAt, proposed.notification.digestedAt]);
  const postingIdentityStatus = postingIdentityStatusForOccurrences(sourceReferences);
  const anyOpen = sourceReferences.some((reference) => reference.state === 'open');
  const season = proposed.season;
  const seasonEvidence = (proposed.internshipIdentity ?? current?.internshipIdentity) as { season?: { evidenceStatus?: string } } | undefined;
  const seasonAllowsOpen = !isPastSeason(season, new Date(proposed.lastSeenAt))
    || (seasonEvidence?.season?.evidenceStatus === 'explicit'
      && sourceReferences.some((reference) => reference.state === 'open' && isOfficialOccurrence(reference)));
  const projected = {
    ...proposed,
    company: presentation.company,
    title: presentation.title,
    location: presentation.location,
    ...(presentation.locations ? { locations: presentation.locations } : {}),
    applyUrl: presentation.applyUrl,
    normalizedUrl: presentation.normalizedUrl,
    fingerprint: presentation.fingerprint,
    sourceReferences,
    ...(admission ? { admission } : {}),
    ...(postingIdentityStatus ? { postingIdentityStatus } : {}),
    technical: sourceReferences.some((reference) => (!anyOpen || reference.state === 'open') && reference.technical !== false),
    open: !proposed.invalidApplicationUrl && anyOpen && seasonAllowsOpen && Boolean(current?.open || proposed.open),
    firstSeenAt: earliest([current?.firstSeenAt, proposed.firstSeenAt]) ?? proposed.firstSeenAt,
    catalogVisibleAt: earliest([
      current?.catalogVisibleAt ?? current?.firstSeenAt,
      proposed.catalogVisibleAt ?? proposed.firstSeenAt,
    ]),
    lastSeenAt: latest([current?.lastSeenAt, proposed.lastSeenAt]) ?? proposed.lastSeenAt,
    notification: {
      smsPending: !smsSentAt && Boolean(current?.notification.smsPending || proposed.notification.smsPending),
      digestPending: !digestedAt && Boolean(current?.notification.digestPending || proposed.notification.digestPending),
      ...(smsSentAt ? { smsSentAt } : {}),
      ...(digestedAt ? { digestedAt } : {}),
    },
  };
  return canonicalCatalogRecency(projected);
}
