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

/** Pure calculation: this class performs no reads, writes, network calls, or logging. */
export class CatalogReconciler {
  reconcile(input: ReconciliationInput): ReconciliationPlan {
    const jobs = new Map<string, Internship>();
    const occurrences: SourceOccurrenceState[] = [];
    const notifications: NotificationEvent[] = [];
    const newJobs: Internship[] = [];
    const filteredJobs: Internship[] = [];
    const includedIds = new Set<string>();

    for (const listing of input.listings) {
      const externalId = listing.externalId ?? `${listing.document}:${normalizeUrl(listing.applyUrl)}`;
      includedIds.add(externalId);
      const existing = jobs.get(input.resolvedJobs.get(externalId)?.jobId ?? '') ?? input.resolvedJobs.get(externalId);
      const validatedAt = input.validatedAt?.get(externalId);
      const job = existing ? merge(existing, listing, externalId, input.now, validatedAt) : create(listing, externalId, input.now, validatedAt);
      const retryingUncommittedCreate = Boolean(existing
        && !input.priorOccurrences.some((prior) => prior.externalId === externalId)
        && existing.sourceReferences.length === 1
        && existing.sourceReferences[0]?.sourceId === input.sourceId
        && existing.sourceReferences[0]?.externalId === externalId);
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
      occurrences.push({
        sourceId: input.sourceId,
        externalId,
        jobId: job.jobId,
        occurrence: occurrence(listing, externalId),
        present: true,
        consecutiveOmissions: 0,
        snapshotHash: input.snapshotHash,
        updatedAt: input.now,
      });
    }

    for (const prior of input.priorOccurrences) {
      if (includedIds.has(prior.externalId)) continue;
      if (input.activeExternalIds.has(prior.externalId)) {
        occurrences.push({ ...prior, present: true, consecutiveOmissions: 0, snapshotHash: input.snapshotHash, updatedAt: input.now });
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
