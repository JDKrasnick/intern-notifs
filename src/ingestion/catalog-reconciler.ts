import { createHash } from 'node:crypto';
import { employerCategory } from '../core/employers.js';
import { isTechnicalJob, matchesJobFilter, type JobFilter } from '../core/filters.js';
import { fingerprint, jobId, normalizeUrl } from '../core/normalize.js';
import type {
  Internship,
  NotificationEvent,
  ProcessedListing,
  SourceOccurrence,
  SourceOccurrenceState,
} from '../types.js';

export interface ReconciliationInput {
  sourceId: string;
  snapshotHash: string;
  activeExternalIds: Set<string>;
  listings: ProcessedListing[];
  priorOccurrences: SourceOccurrenceState[];
  resolvedJobs: Map<string, Internship | undefined>;
  now: string;
  baseline: boolean;
  filter?: JobFilter;
  validatedAt?: Map<string, string>;
  alertEligible?: Set<string>;
}

export interface ReconciliationPlan {
  jobs: Internship[];
  occurrences: SourceOccurrenceState[];
  notifications: NotificationEvent[];
  newJobs: Internship[];
  filteredJobs: Internship[];
}

function occurrence(listing: ProcessedListing, externalId: string): SourceOccurrence {
  return {
    sourceId: listing.sourceId,
    externalId,
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    postedAt: listing.postedAt,
    workMode: listing.workMode,
    company: listing.company,
    title: listing.title,
    location: listing.location,
    season: listing.season,
    applyUrl: listing.applyUrl,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    state: listing.state,
  };
}

/** Key order is normalized so a stored occurrence compares equal to a freshly built one. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A confirmed, unchanged occurrence needs no write; presence lives in the checkpoint. */
function occurrenceChanged(prior: SourceOccurrenceState | undefined, next: SourceOccurrenceState): boolean {
  return !prior
    || prior.present !== next.present
    || prior.consecutiveOmissions !== next.consecutiveOmissions
    || prior.jobId !== next.jobId
    || stableJson(prior.occurrence) !== stableJson(next.occurrence);
}

function genericLocation(value: string | undefined) {
  return !value || /^(unknown|unspecified|n\/?a|not (?:listed|specified)|tbd|see (?:description|job))$/i.test(value.trim());
}

function merge(existing: Internship, listing: ProcessedListing, externalId: string, now: string, applicationUrlValidatedAt?: string): Internship {
  const reference = occurrence(listing, externalId);
  const match = existing.sourceReferences.findIndex((item) =>
    item.sourceId === reference.sourceId
    && (item.externalId ? item.externalId === externalId : item.document === reference.document && item.row === reference.row));
  const location = genericLocation(existing.location) ? listing.location || existing.location : existing.location;
  const company = existing.company || listing.company;
  const sourceReferences = match >= 0
    ? existing.sourceReferences.map((item, index) => index === match ? reference : item)
    : [...existing.sourceReferences, reference];
  const listingNormalizedUrl = normalizeUrl(listing.applyUrl);
  const keepQuarantined = existing.invalidApplicationUrl === listingNormalizedUrl;
  const replaceStoredUrl = Boolean(applicationUrlValidatedAt && (!existing.applicationUrlValidatedAt || existing.normalizedUrl !== listingNormalizedUrl));
  const base = { ...existing };
  if (!keepQuarantined) delete base.invalidApplicationUrl;
  return {
    ...base,
    company,
    title: existing.title || listing.title,
    location,
    applyUrl: replaceStoredUrl ? listing.applyUrl : existing.applyUrl || listing.applyUrl,
    normalizedUrl: replaceStoredUrl ? listingNormalizedUrl : existing.normalizedUrl,
    fingerprint: fingerprint(company, existing.title || listing.title, location, listing.season),
    compensation: listing.compensation.maxHourlyUSD ? listing.compensation : existing.compensation,
    requirements: listing.requirements ?? existing.requirements,
    employerCategory: employerCategory(company),
    sourceReferences,
    technical: listing.technical ?? true,
    open: keepQuarantined ? false : sourceReferences.some((item) => item.state === 'open'),
    lastSeenAt: now,
    ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}),
  };
}

function create(listing: ProcessedListing, externalId: string, now: string, applicationUrlValidatedAt?: string): Internship {
  const normalizedUrl = normalizeUrl(listing.applyUrl);
  const key = fingerprint(listing.company, listing.title, listing.location, listing.season);
  return {
    jobId: jobId(normalizedUrl, key),
    company: listing.company,
    title: listing.title,
    location: listing.location,
    season: listing.season,
    applyUrl: listing.applyUrl,
    normalizedUrl,
    ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}),
    fingerprint: key,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    employerCategory: employerCategory(listing.company),
    sourceReferences: [occurrence(listing, externalId)],
    technical: listing.technical ?? isTechnicalJob(listing),
    open: listing.state === 'open',
    firstSeenAt: now,
    lastSeenAt: now,
    notification: { smsPending: true, digestPending: true },
  };
}

function notificationEvent(sourceId: string, externalId: string, job: Internship, now: string): NotificationEvent {
  return {
    eventId: createHash('sha256').update(`${sourceId}|${externalId}|${job.jobId}|new-job`).digest('hex'),
    sourceId,
    externalId,
    jobId: job.jobId,
    kind: 'new-job',
    createdAt: now,
  };
}

function closeOccurrence(job: Internship, state: SourceOccurrenceState, now: string): Internship {
  const sourceReferences = job.sourceReferences.map((reference) =>
    reference.sourceId === state.sourceId
      && (reference.externalId ? reference.externalId === state.externalId : reference.document === state.occurrence.document && reference.row === state.occurrence.row)
      ? { ...reference, state: 'closed' as const }
      : reference);
  return { ...job, sourceReferences, open: sourceReferences.some((reference) => reference.state === 'open'), lastSeenAt: now };
}

function safeNormalizeUrl(value: string): string {
  try { return normalizeUrl(value); }
  catch { return value; }
}

/** Pure calculation: this class performs no reads, writes, network calls, or logging. */
export class CatalogReconciler {
  reconcile(input: ReconciliationInput): ReconciliationPlan {
    const jobs = new Map<string, Internship>();
    const occurrences: SourceOccurrenceState[] = [];
    const notifications: NotificationEvent[] = [];
    const newJobs: Internship[] = [];
    const filteredJobs: Internship[] = [];
    const includedIds = new Set<string>();
    const priorById = new Map(input.priorOccurrences.map((prior) => [prior.externalId, prior]));
    // One snapshot can list one role twice, across documents or with different
    // tracking links. Resolution happens before any write, so the snapshot keeps
    // its own URL/fingerprint index to merge duplicates and alert exactly once.
    const byUrl = new Map<string, Internship>();
    const byFingerprint = new Map<string, Internship>();

    for (const listing of input.listings) {
      const externalId = listing.externalId ?? `${listing.document}:${safeNormalizeUrl(listing.applyUrl)}`;
      includedIds.add(externalId);
      const listingUrl = safeNormalizeUrl(listing.applyUrl);
      const listingFingerprint = fingerprint(listing.company, listing.title, listing.location, listing.season);
      const stored = input.resolvedJobs.get(externalId);
      const inSnapshot = (stored && jobs.get(stored.jobId)) ?? byUrl.get(listingUrl) ?? byFingerprint.get(listingFingerprint);
      const existing = inSnapshot ?? stored;
      const validatedAt = input.validatedAt?.get(externalId);
      const job = existing ? merge(existing, listing, externalId, input.now, validatedAt) : create(listing, externalId, input.now, validatedAt);
      const retryingUncommittedCreate = Boolean(stored && !inSnapshot
        && !priorById.has(externalId)
        && stored.sourceReferences.length === 1
        && stored.sourceReferences[0]?.sourceId === input.sourceId
        && stored.sourceReferences[0]?.externalId === externalId);
      if (!existing || retryingUncommittedCreate) {
        if (input.baseline || !job.open || !job.technical || !matchesJobFilter(job, input.filter)
          || (input.alertEligible && !input.alertEligible.has(externalId))) {
          job.notification = { smsPending: false, digestPending: false };
          filteredJobs.push(job);
        } else {
          newJobs.push(job);
          notifications.push(notificationEvent(input.sourceId, externalId, job, input.now));
        }
      }
      jobs.set(job.jobId, job);
      byUrl.set(job.normalizedUrl, job);
      byUrl.set(listingUrl, job);
      byFingerprint.set(job.fingerprint, job);
      byFingerprint.set(listingFingerprint, job);
      const next: SourceOccurrenceState = {
        sourceId: input.sourceId,
        externalId,
        jobId: job.jobId,
        occurrence: occurrence(listing, externalId),
        present: true,
        consecutiveOmissions: 0,
        snapshotHash: input.snapshotHash,
        updatedAt: input.now,
      };
      if (occurrenceChanged(priorById.get(externalId), next)) occurrences.push(next);
    }

    for (const prior of input.priorOccurrences) {
      if (includedIds.has(prior.externalId)) continue;
      if (input.activeExternalIds.has(prior.externalId)) {
        const confirmed = { ...prior, present: true, consecutiveOmissions: 0, snapshotHash: input.snapshotHash, updatedAt: input.now };
        if (occurrenceChanged(prior, confirmed)) occurrences.push(confirmed);
        continue;
      }
      const consecutiveOmissions = prior.consecutiveOmissions + 1;
      const next = {
        ...prior,
        present: false,
        consecutiveOmissions,
        snapshotHash: input.snapshotHash,
        updatedAt: input.now,
        occurrence: consecutiveOmissions >= 2 ? { ...prior.occurrence, state: 'closed' as const } : prior.occurrence,
      };
      occurrences.push(next);
      if (consecutiveOmissions < 2) continue;
      const existing = jobs.get(prior.jobId) ?? input.resolvedJobs.get(prior.externalId);
      if (existing) jobs.set(existing.jobId, closeOccurrence(existing, next, input.now));
    }

    return { jobs: [...jobs.values()], occurrences, notifications, newJobs, filteredJobs };
  }
}
