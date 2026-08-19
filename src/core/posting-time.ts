import type { Internship, SourceOccurrence } from '../types.js';

type TimingReference = Pick<SourceOccurrence, 'sourceId' | 'postedAt' | 'providerTimestamp'>;

export type CanonicalPostingTiming = {
  kind: 'posted' | 'found' | 'unknown';
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

export function publishedTimestamp(references: TimingReference[]) {
  const candidates = references.flatMap((reference) => {
    const value = reference.providerTimestamp?.semantics === 'published'
      ? reference.providerTimestamp.value
      : reference.providerTimestamp
        ? undefined
        : reference.postedAt;
    const timestamp = absoluteTimestamp(value);
    return timestamp ? [{ timestamp, official: officialProvider(reference.sourceId) }] : [];
  });
  const official = candidates.filter((candidate) => candidate.official);
  return (official.length ? official : candidates)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0]?.timestamp;
}

export function canonicalPostingTiming(
  job: Pick<Internship, 'sourceReferences' | 'firstSeenAt'>,
): CanonicalPostingTiming {
  const posted = publishedTimestamp(job.sourceReferences);
  if (posted) return { kind: 'posted', timestamp: posted };
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
