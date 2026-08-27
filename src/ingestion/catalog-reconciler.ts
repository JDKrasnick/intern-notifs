import { createHash } from 'node:crypto';
import { employerCategory } from '../core/employers.js';
import { isTechnicalJob, matchesJobFilter, type JobFilter } from '../core/filters.js';
import { fingerprint, jobId, normalizeUrl } from '../core/normalize.js';
import { normalizeInternship, normalizeListing } from '../catalog-quality.js';
import { isOfficialOccurrence } from '../sources/provenance.js';
import { isPastSeason } from '../core/early-career.js';
import { deriveCanonicalAdmission } from '../catalog-admission.js';
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
  metadataValidated?: Map<string, number>;
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
    ...(listing.provenance ? { provenance: listing.provenance } : {}),
    externalId,
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    postedAt: listing.postedAt,
    ...(listing.providerTimestamp ? { providerTimestamp: listing.providerTimestamp } : {}),
    workMode: listing.workMode,
    company: listing.company,
    title: listing.title,
    location: listing.location,
    ...(listing.locations ? { locations: listing.locations } : {}),
    season: listing.season,
    applyUrl: listing.applyUrl,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    technical: listing.technical ?? true,
    state: listing.state,
    ...(listing.admission ? { admission: listing.admission } : {}),
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

function anyOpenTechnicalOccurrence(references: SourceOccurrence[]): boolean {
  return references.some((reference) => reference.state === 'open' && reference.technical !== false);
}

function seasonAllowsOpen(season: string, identity: Internship['internshipIdentity'], references: SourceOccurrence[], now: string): boolean {
  if (!isPastSeason(season, new Date(now))) return true;
  const evidence = (identity as { season?: { evidenceStatus?: string } } | undefined)?.season?.evidenceStatus;
  return evidence === 'explicit' && references.some((reference) => reference.state === 'open' && isOfficialOccurrence(reference));
}

function merge(existing: Internship, listing: ProcessedListing, externalId: string, now: string, applicationUrlValidatedAt?: string, metadataVersion?: number): Internship {
  existing = normalizeInternship(existing);
  listing = normalizeListing(listing);
  const reference = occurrence(listing, externalId);
  const match = existing.sourceReferences.findIndex((item) =>
    item.sourceId === reference.sourceId
    && (item.externalId ? item.externalId === externalId : item.document === reference.document && item.row === reference.row));
  const incomingOfficial = isOfficialOccurrence(listing);
  const preferIncoming = incomingOfficial && (listing.admission?.catalogEligible ?? true);
  const useIncomingLocation = genericLocation(existing.location) || (!genericLocation(listing.location) && preferIncoming);
  const location = useIncomingLocation ? listing.location || existing.location : existing.location;
  const locations = useIncomingLocation ? listing.locations ?? existing.locations : existing.locations ?? listing.locations;
  const company = preferIncoming ? listing.company || existing.company : existing.company || listing.company;
  const title = preferIncoming ? listing.title || existing.title : existing.title || listing.title;
  const sourceReferences = match >= 0
    ? existing.sourceReferences.map((item, index) => index === match ? {
      ...reference,
      ...(item.firstAttachedAt ? { firstAttachedAt: item.firstAttachedAt } : {}),
      ...(item.firstAttachedAtPrecision ? { firstAttachedAtPrecision: item.firstAttachedAtPrecision } : item.firstAttachedAt ? { firstAttachedAtPrecision: 'exact' as const } : { firstAttachedAtPrecision: 'unknown' as const }),
    } : item)
    : [...existing.sourceReferences, { ...reference, firstAttachedAt: now, firstAttachedAtPrecision: 'exact' as const }];
  const admission = deriveCanonicalAdmission(sourceReferences, now);
  const listingNormalizedUrl = normalizeUrl(listing.applyUrl);
  const keepQuarantined = existing.invalidApplicationUrl === listingNormalizedUrl;
  const replaceStoredUrl = Boolean(applicationUrlValidatedAt && (!existing.applicationUrlValidatedAt || existing.normalizedUrl !== listingNormalizedUrl));
  const base = { ...existing };
  if (!keepQuarantined) delete base.invalidApplicationUrl;
  const internshipIdentity = listing.internshipIdentity ?? existing.internshipIdentity;
  const canonicalCompany = admission?.canonicalEmployer?.displayName;
  return normalizeInternship({
    ...base,
    company: canonicalCompany ?? company,
    title,
    location,
    ...(locations ? { locations } : {}),
    season: listing.season,
    applyUrl: replaceStoredUrl ? listing.applyUrl : existing.applyUrl || listing.applyUrl,
    normalizedUrl: replaceStoredUrl ? listingNormalizedUrl : existing.normalizedUrl,
    postingIdentity: listing.postingIdentity ?? existing.postingIdentity,
    internshipIdentity,
    fingerprint: fingerprint(company, title, location, listing.season),
    compensation: listing.compensation.maxHourlyUSD ? listing.compensation : existing.compensation,
    requirements: {
      requiresUsCitizenship: Boolean(listing.requirements?.requiresUsCitizenship || existing.requirements?.requiresUsCitizenship),
      advancedDegreeRequired: Boolean(listing.requirements?.advancedDegreeRequired || existing.requirements?.advancedDegreeRequired),
    },
    employerCategory: employerCategory(company),
    sourceReferences,
    ...(admission ? { admission } : {}),
    technical: anyOpenTechnicalOccurrence(sourceReferences),
    open: keepQuarantined ? false : sourceReferences.some((item) => item.state === 'open') && seasonAllowsOpen(listing.season, internshipIdentity, sourceReferences, now),
    lastSeenAt: now,
    ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}),
    ...(metadataVersion ? { applicationPageMetadataVersion: metadataVersion } : {}),
  });
}

function create(listing: ProcessedListing, externalId: string, now: string, baseline: boolean, applicationUrlValidatedAt?: string, metadataVersion?: number): Internship {
  listing = normalizeListing(listing);
  const normalizedUrl = normalizeUrl(listing.applyUrl);
  const key = fingerprint(listing.company, listing.title, listing.location, listing.season);
  const reference = { ...occurrence(listing, externalId), firstAttachedAt: now, firstAttachedAtPrecision: 'exact' as const };
  const admission = deriveCanonicalAdmission([reference], now);
  return {
    jobId: listing.postingIdentity?.canonicalJobId ?? jobId(normalizedUrl, key),
    company: admission?.canonicalEmployer?.displayName ?? listing.company,
    title: listing.title,
    location: listing.location,
    ...(listing.locations ? { locations: listing.locations } : {}),
    season: listing.season,
    applyUrl: listing.applyUrl,
    normalizedUrl,
    ...(listing.postingIdentity ? { postingIdentity: listing.postingIdentity } : {}),
    ...(listing.internshipIdentity ? { internshipIdentity: listing.internshipIdentity } : {}),
    ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}),
    ...(metadataVersion ? { applicationPageMetadataVersion: metadataVersion } : {}),
    fingerprint: key,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    employerCategory: employerCategory(listing.company),
    sourceReferences: [reference],
    ...(admission ? { admission } : {}),
    technical: listing.technical ?? isTechnicalJob(listing),
    open: listing.state === 'open' && seasonAllowsOpen(listing.season, listing.internshipIdentity, [reference], now),
    firstSeenAt: now,
    catalogVisibleAt: now,
    catalogRecency: baseline ? 'baseline' : 'normal',
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
  return {
    ...job,
    sourceReferences,
    ...(deriveCanonicalAdmission(sourceReferences, now) ? { admission: deriveCanonicalAdmission(sourceReferences, now) } : {}),
    technical: anyOpenTechnicalOccurrence(sourceReferences),
    open: sourceReferences.some((reference) => reference.state === 'open')
      && seasonAllowsOpen(job.season, job.internshipIdentity, sourceReferences, now),
    lastSeenAt: now,
  };
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
    // One snapshot can list one exact posting twice, across documents or through
    // reviewed provider URL variants. Only exact identity or URL evidence may
    // converge them; title/location fingerprints can collide across requisitions.
    const byUrl = new Map<string, Internship>();
    const byPostingIdentity = new Map<string, Internship>();

    for (const listing of input.listings) {
      const externalId = listing.externalId ?? `${listing.document}:${safeNormalizeUrl(listing.applyUrl)}`;
      includedIds.add(externalId);
      const listingUrl = safeNormalizeUrl(listing.applyUrl);
      const stored = input.resolvedJobs.get(externalId);
      const inSnapshot = (stored && jobs.get(stored.jobId))
        ?? (listing.postingIdentity ? byPostingIdentity.get(listing.postingIdentity.canonicalJobId) : undefined)
        ?? byUrl.get(listingUrl);
      const existing = inSnapshot ?? stored;
      const validatedAt = input.validatedAt?.get(externalId);
      const metadataVersion = input.metadataValidated?.get(externalId);
      const job = existing
        ? merge(existing, listing, externalId, input.now, validatedAt, metadataVersion)
        : create(listing, externalId, input.now, input.baseline, validatedAt, metadataVersion);
      const retryingUncommittedCreate = Boolean(stored && !inSnapshot
        && !priorById.has(externalId)
        && stored.sourceReferences.length === 1
        && stored.sourceReferences[0]?.sourceId === input.sourceId
        && stored.sourceReferences[0]?.externalId === externalId);
      if (!existing || retryingUncommittedCreate) {
        if (input.baseline || !job.open || !job.technical || !matchesJobFilter(job, input.filter)
          || job.admission?.alertEligible === false
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
      if (listing.postingIdentity) byPostingIdentity.set(listing.postingIdentity.canonicalJobId, job);
      const next: SourceOccurrenceState = {
        sourceId: input.sourceId,
        externalId,
        jobId: job.jobId,
        occurrence: occurrence(listing, externalId),
        present: true,
        consecutiveOmissions: 0,
        changedSnapshotHash: input.snapshotHash,
        changedAt: input.now,
        ...(priorById.get(externalId)?.firstObservedAt
          ? { firstObservedAt: priorById.get(externalId)!.firstObservedAt }
          : priorById.has(externalId)
            ? { firstObservedAtPrecision: 'unknown' as const }
            : { firstObservedAt: input.now, firstObservedAtPrecision: 'exact' as const }),
        ...(priorById.get(externalId)?.firstObservedAtPrecision
          ? { firstObservedAtPrecision: priorById.get(externalId)!.firstObservedAtPrecision }
          : {}),
      };
      if (occurrenceChanged(priorById.get(externalId), next)) occurrences.push(next);
    }

    for (const prior of input.priorOccurrences) {
      if (includedIds.has(prior.externalId)) continue;
      if (input.activeExternalIds.has(prior.externalId)) {
        const confirmed = { ...prior, present: true, consecutiveOmissions: 0, changedSnapshotHash: input.snapshotHash, changedAt: input.now };
        if (occurrenceChanged(prior, confirmed)) occurrences.push(confirmed);
        continue;
      }
      const consecutiveOmissions = prior.consecutiveOmissions + 1;
      const next = {
        ...prior,
        present: false,
        consecutiveOmissions,
        changedSnapshotHash: input.snapshotHash,
        changedAt: input.now,
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
