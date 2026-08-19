import type { Internship, SourceOccurrence } from '../types.js';

type TimingReference = Pick<SourceOccurrence, 'sourceId' | 'postedAt' | 'providerTimestamp'>;

export type CanonicalPostingTiming = {
  kind: 'employer-posted' | 'source-reported' | 'found' | 'unknown';
  timestamp?: string;
};

const absoluteDatePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function absoluteTimestamp(value: string | undefined) {
  if (!value || !absoluteDatePattern.test(value)) return undefined;
  return Number.isNaN(new Date(value).valueOf()) ? undefined : value;
}

function officialProvider(sourceId: string) {
  return /^(?:ashby|greenhouse|lever)-/i.test(sourceId);
}

function publicationTiming(references: TimingReference[]): CanonicalPostingTiming | undefined {
  const candidates = references.flatMap((reference) => {
    const official = officialProvider(reference.sourceId);
    const providerTimestamp = reference.providerTimestamp;
    const explicitlyPublished = providerTimestamp?.semantics === 'published';
    const value = explicitlyPublished
      ? providerTimestamp.value
      : !providerTimestamp && !official
        ? reference.postedAt
        : undefined;
    const timestamp = absoluteTimestamp(value);
    return timestamp ? [{ timestamp, official: explicitlyPublished && official }] : [];
  });
  const official = candidates.filter((candidate) => candidate.official);
  const selected = (official.length ? official : candidates)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0];
  return selected
    ? { kind: selected.official ? 'employer-posted' : 'source-reported', timestamp: selected.timestamp }
    : undefined;
}

export function publishedTimestamp(references: TimingReference[]) {
  return publicationTiming(references)?.timestamp;
}

export function canonicalPostingTiming(
  job: Pick<Internship, 'sourceReferences' | 'firstSeenAt'>,
): CanonicalPostingTiming {
  const publication = publicationTiming(job.sourceReferences);
  if (publication) return publication;
  const found = absoluteTimestamp(job.firstSeenAt);
  return found ? { kind: 'found', timestamp: found } : { kind: 'unknown' };
}

export function formatPostingDate(timestamp: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
