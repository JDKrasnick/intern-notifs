import { createHash } from 'node:crypto';
import { assessApplicationPageForListing, canonicalApplicationUrl, type ApplicationPageEvidence, type ApplicationUrlValidator } from './core/application-url.js';
import { boardReference, reachabilityFromFailure, reachabilityFromSignals, verifyApplication, type AttributionBasis, type Reachability } from './core/application-verification.js';
import { inferSeason, isPastSeason } from './core/early-career.js';
import { normalizeUrl } from './core/normalize.js';
import type { ProviderPostingReference } from './identity/posting.js';
import { resolvePostingIdentityDecision, stableSourceOccurrenceJobId } from './identity/registry.js';
import {
  providerEvidenceForOccurrence,
  reviewedProviderEvidenceError,
  reviewedProviderUrlReference,
  uniqueGreenhouseEvidenceForSources,
  unscopedGreenhouseEmbedPostingId,
  unscopedGreenhouseEmbedUrls,
} from './identity/reviewed-provider.js';
import { isTechnicalJob, type JobFilter } from './core/filters.js';
import { CatalogReconciler } from './ingestion/catalog-reconciler.js';
import { evaluateSourceFreshness } from './ingestion/monitoring.js';
import { sourceProvider, sourceRegion } from './integration-registry.js';
import { processSnapshot } from './ingestion/processor.js';
import { evaluateCatalogAdmission } from './catalog-admission.js';
import { classifyDestination, matchingBrowserDestination, requiresBrowserVerification, type CatalogAdmissionResolver, type DestinationVerificationRequest } from './destination-verification.js';
import { reviewedBoardIndex } from './sources/index.js';
import { sourceQualityFailures } from './sources/quality.js';
import { SourceFetchError } from './sources/source-error.js';
import { failedSourceHealth, sourceFailureOutcome, successfulSourceHealth } from './source-health.js';
import type {
  Internship,
  ProcessedListing,
  ProcessedSnapshot,
  SourceAdapter,
  SourceCheckpoint,
  SourceFetchResult,
  SourceHealth,
  SourceOccurrence,
  SourceOccurrenceState,
  SourceSnapshot,
} from './types.js';
import type { InternshipStore } from './store.js';

const applicationPageMetadataVersion = 1;

function stableSourceMaterial(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSourceMaterial).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSourceMaterial(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sourceOwnedMaterial(value: ProcessedListing | SourceOccurrence): string {
  // GitHub row numbers and fetch timestamps move whenever a maintainer edits
  // the Markdown around a role. Compare only facts the source owns so that
  // layout churn does not force a catalog read/write cycle for every row.
  return stableSourceMaterial({
    provenance: value.provenance,
    document: value.document,
    sourceUrl: value.sourceUrl,
    postedAt: value.postedAt,
    providerTimestamp: value.providerTimestamp,
    workMode: value.workMode,
    company: value.company,
    title: value.title,
    location: value.location,
    locations: value.locations,
    season: value.season,
    applyUrl: value.applyUrl,
    compensation: value.compensation,
    requirements: value.requirements,
    technical: value.technical ?? true,
    state: value.state,
    providerEvidence: value.providerEvidence,
  });
}

// Catalog rows written before posting identity v1 retained gh_src while
// removing the older, general tracking parameters. Keep this lookup shape
// only for adoption during the migration window; all new writes use the
// canonical posting URL.
function legacyNormalizedUrl(input: string): string {
  const tracking = new Set([
    'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  ]);
  const url = new URL(input.trim());
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  for (const key of [...url.searchParams.keys()]) {
    if (tracking.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

function quarantinedOccurrence(
  listing: ProcessedListing,
  externalId: string,
  decision: Extract<NonNullable<ProcessedListing['postingIdentityDecision']>, { status: 'quarantined' }>,
): SourceOccurrence {
  return {
    sourceId: listing.sourceId,
    ...(listing.provenance ? { provenance: listing.provenance } : {}),
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    ...(listing.postedAt ? { postedAt: listing.postedAt } : {}),
    externalId,
    ...(listing.providerEvidence ? { providerEvidence: listing.providerEvidence } : {}),
    postingIdentityDecision: decision,
    company: listing.company,
    title: listing.title,
    location: listing.location,
    ...(listing.locations ? { locations: listing.locations } : {}),
    season: listing.season,
    applyUrl: listing.applyUrl,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    technical: listing.technical,
    state: listing.state,
  };
}

export interface PollReport {
  fetchedSources: number;
  unchangedSources: string[];
  baselineSources: string[];
  processedListings: number;
  newJobs: Internship[];
  filteredJobs: Internship[];
  quarantinedListings: Array<{ sourceId: string; row: number; reason: string }>;
  failures: string[];
}

interface TrustedBatch {
  fetchResult: SourceFetchResult;
  processed: ProcessedSnapshot;
  snapshotHash: string;
  activeExternalIds: Set<string>;
  unchanged: boolean;
}

interface PrefetchedBoardFetch {
  attemptedAt: string;
  started: number;
  previous?: SourceCheckpoint;
  admissionConfigurationVersion?: string;
  result?: SourceFetchResult;
  error?: unknown;
}

const SOURCE_WORK_CONCURRENCY = 24;
const MAX_IN_PROCESS_RETRY_DELAY_MS = 60_000;

/**
 * Bounded worker pool that always drains: the first error is rethrown only once
 * every worker has settled, so a failed slice never leaves writes in flight.
 */
async function forEachBounded<T>(items: readonly T[], task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { await task(items[index]!, index); }
      catch (error) { failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOURCE_WORK_CONCURRENCY, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

function providerFor(sourceId: string): SourceHealth['provider'] {
  return sourceProvider(sourceId);
}

function regionFor(provider: SourceHealth['provider']): NonNullable<SourceHealth['region']> {
  return sourceRegion(provider);
}

function emitSuccessMetric(
  sourceId: string,
  provider: SourceHealth['provider'],
  outcome: 'success_changed' | 'success_unchanged_304' | 'success_unchanged_hash',
  counts: ProcessedSnapshot['counts'],
  durationMs: number,
  conditionalRequest?: SourceFetchResult['conditionalRequest'],
  runId?: string,
) {
  const region = regionFor(provider);
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['provider', 'region', 'outcome']],
        Metrics: [
          { Name: 'SourceFetchSuccess', Unit: 'Count' },
          { Name: 'SourceFetchDurationMs', Unit: 'Milliseconds' },
          { Name: 'RawListingCount', Unit: 'Count' },
          { Name: 'EligibleListingCount', Unit: 'Count' },
          { Name: 'ListingWithheld', Unit: 'Count' },
          ...(conditionalRequest ? [
            { Name: 'ConditionalRequestAttempted', Unit: 'Count' },
            { Name: 'ConditionalRequestNotModified', Unit: 'Count' },
            ...(conditionalRequest.validatorChanged !== undefined
              ? [{ Name: 'ValidatorChanged', Unit: 'Count' }]
              : []),
          ] : []),
        ],
      }],
    },
    event: 'source_fetch_completed',
    runId,
    sourceId,
    provider,
    region,
    outcome,
    SourceFetchSuccess: 1,
    SourceFetchDurationMs: durationMs,
    RawListingCount: counts.raw,
    EligibleListingCount: counts.eligible,
    ListingWithheld: counts.withheld,
    ...(conditionalRequest ? {
      conditionalRequestAttempted: conditionalRequest.attempted,
      conditionalRequestNotModified: conditionalRequest.notModified,
      ...(conditionalRequest.validatorChanged !== undefined
        ? { validatorChanged: conditionalRequest.validatorChanged }
        : {}),
      ConditionalRequestAttempted: Number(conditionalRequest.attempted),
      ConditionalRequestNotModified: Number(conditionalRequest.notModified),
      ...(conditionalRequest.validatorChanged !== undefined
        ? { ValidatorChanged: Number(conditionalRequest.validatorChanged) }
        : {}),
    } : {}),
    counts,
  }));
}

function emitFreshnessMetric(records: SourceHealth[], now: Date) {
  const freshness = evaluateSourceFreshness(records, now);
  const polled = new Set(records.map((record) => record.provider));
  for (const [provider, staleCount] of Object.entries(freshness.byProvider).filter(([name]) => polled.has(name))) {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [{
          Namespace: 'InternNotifs/Ingestion',
          Dimensions: [['provider']],
          Metrics: [{ Name: 'StaleSourceCount', Unit: 'Count' }],
        }],
      },
      event: 'source_freshness_evaluated',
      provider,
      StaleSourceCount: staleCount,
      staleSourceIds: freshness.staleSourceIds.filter((sourceId) => providerFor(sourceId) === provider),
    }));
  }
}

function emitFailureMetric(
  sourceId: string,
  provider: SourceHealth['provider'],
  category: NonNullable<SourceHealth['diagnosticCategory']>,
  durationMs: number,
  outcome: string,
  runId?: string,
) {
  const region = regionFor(provider);
  const rejected = ['json', 'identity', 'link', 'empty', 'quality'].includes(category) ? 1 : 0;
  console.error(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['provider', 'region', 'category']],
        Metrics: [
          { Name: 'SourceFetchFailure', Unit: 'Count' },
          { Name: 'SourceFetchDurationMs', Unit: 'Milliseconds' },
          { Name: 'SnapshotRejected', Unit: 'Count' },
        ],
      }],
    },
    event: 'source_fetch_failed',
    runId,
    sourceId,
    provider,
    region,
    category,
    outcome,
    SourceFetchFailure: 1,
    SourceFetchDurationMs: durationMs,
    SnapshotRejected: rejected,
  }));
}

function isSourceSnapshot(result: SourceFetchResult): result is SourceFetchResult & SourceSnapshot {
  return 'postings' in result && 'complete' in result && 'outcome' in result;
}

function externalId(listing: ProcessedListing): string {
  if (listing.externalId) return listing.externalId;
  try { return `${listing.document}:${normalizeUrl(listing.applyUrl)}`; }
  catch { return `${listing.document}:invalid:${listing.applyUrl}`; }
}

function sameApplicationUrl(left: string, right: string): boolean {
  try { return normalizeUrl(canonicalApplicationUrl(left)) === right; }
  catch { return false; }
}

function legacyBatch(result: SourceFetchResult): TrustedBatch {
  const listings = result.listings.map((listing) => ({
    ...listing,
    externalId: externalId(listing),
    technical: listing.technical ?? isTechnicalJob(listing),
  }));
  const snapshotHash = result.checkpoint.contentHash
    ?? createHash('sha256').update(JSON.stringify(listings, (key, value) => key === 'fetchedAt' ? undefined : value)).digest('hex');
  return {
    fetchResult: result,
    processed: {
      listings,
      decisions: listings.map((listing) => ({ externalId: externalId(listing), outcome: 'included' as const, reason: 'source-policy' as const })),
      counts: {
        raw: result.rawRowCount ?? listings.length,
        valid: listings.length,
        eligible: listings.filter((listing) => listing.technical !== false).length,
        shelved: listings.filter((listing) => listing.technical === false).length,
        filtered: 0,
        withheld: result.rejectedApplicationUrls?.length ?? 0,
      },
    },
    snapshotHash,
    activeExternalIds: new Set(result.checkpoint.activeExternalIds ?? listings.map(externalId)),
    unchanged: result.notModified,
  };
}

function neutralBatch(result: SourceFetchResult & SourceSnapshot): TrustedBatch {
  const processed = result.processed ?? processSnapshot(result);
  return {
    fetchResult: result,
    processed,
    snapshotHash: result.contentHash,
    activeExternalIds: new Set(result.checkpoint.activeExternalIds ?? result.postings.map((posting) => posting.externalId)),
    unchanged: result.outcome === 'unchanged',
  };
}

function retryable(error: unknown): boolean {
  return error instanceof SourceFetchError ? error.retryable : error instanceof TypeError || (error as { name?: string })?.name === 'AbortError';
}

async function fetchWithRetry(adapter: SourceAdapter, checkpoint: SourceCheckpoint | undefined): Promise<SourceFetchResult> {
  let finalError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await adapter.fetch(checkpoint);
    } catch (error) {
      finalError = error;
      if (!retryable(error) || attempt === 3) throw error;
      const exponentialDelay = 25 * (2 ** (attempt - 1));
      const retryAfterMs = error instanceof SourceFetchError ? error.retryAfterMs : undefined;
      // Let the durable source-health backoff handle longer provider windows;
      // never keep a queue worker asleep past its bounded retry budget.
      if (retryAfterMs !== undefined && retryAfterMs > MAX_IN_PROCESS_RETRY_DELAY_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.max(exponentialDelay, retryAfterMs ?? 0)));
    }
  }
  throw finalError;
}

export class IngestionRunner {
  private readonly reconciler = new CatalogReconciler();

  constructor(
    private readonly connectors: SourceAdapter[],
    private readonly store: InternshipStore,
    private readonly now: () => Date = () => new Date(),
    private readonly filter?: JobFilter,
    private readonly validateApplicationUrl?: ApplicationUrlValidator,
    private readonly validateCatalogApplicationUrl: ApplicationUrlValidator | false | undefined = validateApplicationUrl,
    private readonly enqueueDestinationVerification?: (request: DestinationVerificationRequest) => Promise<void>,
    private readonly catalogAdmissionResolver?: CatalogAdmissionResolver,
    private readonly publishUnconfirmedIdentities = true,
  ) {}

  private async quarantine(job: Internship) {
    await this.store.putInternship({
      ...job,
      open: false,
      invalidApplicationUrl: job.normalizedUrl,
      notification: { ...job.notification, smsPending: false, digestPending: false },
    });
  }

  private async validateUnverifiedOpenJobs(report: PollReport) {
    if (!this.validateCatalogApplicationUrl || !this.store.listOpen) return;
    const validateCatalogApplicationUrl = this.validateCatalogApplicationUrl;
    let cursor: string | undefined;
    do {
      const page = await this.store.listOpen(cursor, 100, 'open');
      cursor = page.cursor;
      const jobs = page.jobs.filter((job) => !job.applicationUrlValidatedAt);
      let nextJob = 0;
      const validateJob = async () => {
        const job = jobs[nextJob++];
        if (!job) return;
        try {
          await validateCatalogApplicationUrl(job.applyUrl);
          await this.store.putInternship({ ...job, applicationUrlValidatedAt: this.now().toISOString() });
        } catch (error) {
          // A refused read or a timeout says nothing about the posting; only a
          // destination proven gone hides a role a source still lists.
          if (reachabilityFromFailure(error) === 'gone') await this.quarantine(job);
          report.failures.push(`catalog: ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(24, jobs.length) }, async () => {
        while (nextJob < jobs.length) await validateJob();
      }));
    } while (cursor);
  }

  private readonly boardIndex = reviewedBoardIndex();
  private readonly boardActiveIds = new Map<string, Promise<Set<string>>>();
  private readonly currentRunGreenhouseActiveIds = new Map<string, Set<string>>();
  private boardCheckpoints?: Promise<Map<string, SourceCheckpoint>>;

  private activePostingIds(sourceId: string): Promise<Set<string>> {
    const current = this.currentRunGreenhouseActiveIds.get(sourceId);
    if (current) return Promise.resolve(current);
    if (!this.boardActiveIds.has(sourceId)) {
      this.boardActiveIds.set(sourceId, this.store.getCheckpoint(sourceId)
        .then((checkpoint) => new Set(checkpoint?.activeExternalIds ?? []))
        .catch(() => new Set<string>()));
    }
    return this.boardActiveIds.get(sourceId)!;
  }

  private async uniqueActiveGreenhouseEvidence(postingId: string, urls: string[]) {
    const sourceIds = [...new Set(this.boardIndex.values())];
    this.boardCheckpoints ??= this.store.getCheckpointsMany(sourceIds)
      .then((checkpoints) => new Map(checkpoints.map((checkpoint) => [checkpoint.sourceId, checkpoint])));
    const checkpoints = await this.boardCheckpoints;
    const activeSources = sourceIds.flatMap((sourceId) => {
      const evidence = providerEvidenceForOccurrence(sourceId, postingId, urls);
      if (evidence?.provider !== 'greenhouse') return [];
      const current = this.currentRunGreenhouseActiveIds.get(sourceId);
      return (current ? current.has(postingId) : checkpoints.get(sourceId)?.activeExternalIds?.includes(postingId)) ? [sourceId] : [];
    });
    return uniqueGreenhouseEvidenceForSources(postingId, activeSources, urls);
  }

  private async reviewedReferences(listing: ProcessedListing): Promise<ProviderPostingReference[]> {
    if (listing.providerEvidence) {
      const error = reviewedProviderEvidenceError(listing.providerEvidence);
      if (error) throw new Error(error);
    }
    const references: ProviderPostingReference[] = [];
    const urls = [listing.applyUrl, ...(listing.providerEvidence?.urls ?? [])];
    for (const url of urls) {
      const result = reviewedProviderUrlReference(url);
      if (result.outcome === 'conflict') throw new Error(result.reason);
      if (result.outcome !== 'match') {
        const postingId = unscopedGreenhouseEmbedPostingId(url);
        const evidence = postingId ? await this.uniqueActiveGreenhouseEvidence(postingId, [url]) : undefined;
        if (evidence) references.push({ provider: evidence.provider, tenant: evidence.tenant, postingId: evidence.postingId });
        continue;
      }
      const direct = listing.providerEvidence?.sourceId === result.reference.sourceId;
      if (direct || listing.providerEvidence || (await this.activePostingIds(result.reference.sourceId)).has(result.reference.postingId)) {
        references.push(result.reference);
      }
    }
    return references;
  }

  private async inferredEmbedAliases(listing: ProcessedListing): Promise<string[]> {
    const evidence = listing.providerEvidence;
    if (evidence?.provider !== 'greenhouse') return [];
    const unique = await this.uniqueActiveGreenhouseEvidence(evidence.postingId, evidence.urls ?? []);
    if (!unique || unique.sourceId !== evidence.sourceId || unique.tenant.toLowerCase() !== evidence.tenant.toLowerCase()) return [];
    return unscopedGreenhouseEmbedUrls(evidence.postingId);
  }

  /** Provider existence and destination validity are separate facts. Attribution
   * requires an exact hosted/apply route; a provider ID on a generic custom page
   * is still inspected like any other destination. */
  private async attribute(listing: ProcessedListing): Promise<AttributionBasis> {
    const reference = boardReference(listing.applyUrl);
    const sourceId = reference && this.boardIndex.get(`${reference.provider}:${reference.token}`);
    if (!reference || !sourceId) return 'unattributed';
    const evidence = listing.providerEvidence;
    if (evidence
      && evidence.provider === reference.provider
      && evidence.tenant.toLowerCase() === reference.token
      && evidence.postingId.toLowerCase() === reference.postingId.toLowerCase()
      && evidence.sourceId === sourceId) return 'provider-api';
    return (await this.activePostingIds(sourceId)).has(reference.postingId) ? 'reviewed-board' : 'unattributed';
  }

  private async resolveListings(
    listings: ProcessedListing[],
    report: PollReport,
    priorOccurrences: SourceOccurrenceState[] = [],
    admissionConfigurationVersion?: string,
    reuseUnchangedOccurrences = false,
  ) {
    const resolved = new Map<string, Internship | undefined>();
    const validatedAt = new Map<string, string>();
    const metadataValidated = new Map<string, number>();
    const alertEligible = new Set<string>();
    // Slots keep the snapshot order stable so duplicate merging, alert order, and
    // reported failures do not depend on which worker finished first.
    const accepted = new Array<ProcessedListing | undefined>(listings.length);
    const failures = new Array<string | undefined>(listings.length);
    const priorByExternalId = new Map(priorOccurrences.map((occurrence) => [occurrence.externalId, occurrence]));
    await forEachBounded(listings, async (sourceListing, slot) => {
      // Transitional RawListing adapters predate provider-neutral evidence.
      // Real connectors now emit SourceSnapshot postings and are always managed
      // by record-level admission; legacy rows retain their rollout behavior
      // until the reviewed backfill classifies them.
      const supportsAdmission = Boolean(sourceListing.employerEvidence || sourceListing.providerIdentity);
      let legacyUrl: string;
      let canonicalUrl: string;
      try {
        legacyUrl = legacyNormalizedUrl(sourceListing.applyUrl);
        canonicalUrl = canonicalApplicationUrl(sourceListing.applyUrl);
      } catch (error) {
        failures[slot] = `${sourceListing.sourceId}: row ${sourceListing.row}: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      let listing = {
        ...sourceListing,
        externalId: externalId(sourceListing),
        applyUrl: canonicalUrl,
        technical: sourceListing.technical ?? true,
        ...(admissionConfigurationVersion ? { admissionConfigurationVersion } : {}),
      };
      const id = listing.externalId;
      const priorOccurrence = priorByExternalId.get(id);
      const admissionAlreadyApplied = Boolean(admissionConfigurationVersion
        && priorOccurrence?.occurrence.admissionConfigurationVersion === admissionConfigurationVersion);
      if ((reuseUnchangedOccurrences || admissionAlreadyApplied) && priorOccurrence
        && sourceOwnedMaterial(priorOccurrence.occurrence) === sourceOwnedMaterial(listing)) return;
      let existing: Internship | undefined;
      let identityMerged = false;
      try {
        const normalizedUrl = normalizeUrl(listing.applyUrl);
        const reviewedProviderReferences = await this.reviewedReferences(listing);
        const observedUrls = await this.inferredEmbedAliases(listing);
        const identityResult = resolvePostingIdentityDecision({
          sourceId: listing.sourceId,
          externalId: id,
          applicationUrl: listing.applyUrl,
          observedAt: this.now().toISOString(),
          ...(listing.providerEvidence ? { providerEvidence: listing.providerEvidence } : {}),
          reviewedProviderReferences,
          observedUrls,
          previousDecision: priorByExternalId.get(id)?.occurrence.postingIdentityDecision,
        });
        if (identityResult.decision.status === 'quarantined') {
          await this.store.commitPostingObservation({
            decision: identityResult.decision,
            sourceId: listing.sourceId,
            externalId: id,
            occurrence: quarantinedOccurrence(listing, id, identityResult.decision),
          });
          report.quarantinedListings.push({
            sourceId: listing.sourceId,
            row: listing.row,
            reason: `posting identity conflict (${identityResult.decision.reason})`,
          });
          return;
        }
        const identity = identityResult.identity;
        // A legacy row may be adopted only through its exact canonical URL.
        // Title/location fingerprints are search hints, not proof that two
        // employer requisitions are the same posting.
        const prior = priorByExternalId.get(id);
        existing = prior ? await this.store.getJob(prior.jobId) : undefined;
        const lookupUrls = [...new Set([
          normalizedUrl,
          legacyUrl,
          ...observedUrls,
          ...(identity?.aliases.filter((candidate) => candidate.value.startsWith('url:')).map((candidate) => candidate.value.slice(4)) ?? []),
        ])];
        if (!existing) {
          for (const lookupUrl of lookupUrls) {
            const candidate = await this.store.findByUrl(lookupUrl);
            if (!candidate) continue;
            const sameSourceOccurrence = candidate.sourceReferences.some((reference) => reference.sourceId === listing.sourceId
              && (reference.externalId === id || (!reference.externalId && reference.document === listing.document && reference.row === listing.row)));
            const adoptableLegacyCandidate = Boolean(identity) && candidate.postingIdentityStatus === undefined;
            const reviewedIdentityUrl = Boolean(identity)
              && candidate.postingIdentityStatus === 'unconfirmed'
              && observedUrls.some((observedUrl) => normalizeUrl(observedUrl) === lookupUrl);
            if (adoptableLegacyCandidate || reviewedIdentityUrl || sameSourceOccurrence) { existing = candidate; break; }
          }
        }
        if (identity) {
          const identityResolution = await this.store.resolvePostingIdentity(identity, existing?.jobId);
          if (identityResolution.outcome === 'quarantine') {
            const decision = {
              status: 'quarantined' as const,
              reason: identityResolution.reason,
              contradictoryEvidence: identityResolution.conflictingCanonicalJobIds,
              reviewFamilyKey: identityResult.decision.status === 'confirmed'
                ? identityResult.decision.exactKey
                : identityResult.decision.reviewFamilyKey,
              observedAt: identityResult.decision.observedAt,
            };
            await this.store.commitPostingObservation({
              decision,
              sourceId: listing.sourceId,
              externalId: id,
              occurrence: quarantinedOccurrence(listing, id, decision),
            });
            report.quarantinedListings.push({
              sourceId: listing.sourceId,
              row: listing.row,
              reason: `posting identity conflict (${identityResolution.reason})`,
            });
            return;
          }
          if (!existing || existing.jobId !== identityResolution.canonicalJobId) {
            existing = await this.store.getJob(identityResolution.canonicalJobId);
          }
          identityMerged = identityResolution.outcome === 'merge';
          identity.canonicalJobId = identityResolution.canonicalJobId;
        }
        listing = {
          ...listing,
          postingIdentityDecision: identityResult.decision,
          ...(identity ? { postingIdentity: identity } : {}),
        };
        if (supportsAdmission && listing.providerIdentity && this.catalogAdmissionResolver) {
          const canonicalEmployer = await this.catalogAdmissionResolver.resolveCanonicalEmployer(listing.providerIdentity);
          if (canonicalEmployer) listing = {
            ...listing,
            employerEvidence: { authority: 'reviewed-registry', canonicalEmployer },
          };
        }
        // Existing unclassified rows keep their rollout behavior until a
        // reviewed mapping exists. A refreshed URL is also safe when an
        // already-claimed immutable provider posting proves it is the same
        // requisition. New rows and otherwise unproven destination changes
        // fail closed, so activating admission cannot hide the legacy catalog.
        const knownLegacyDestination = existing?.normalizedUrl === normalizedUrl
          || existing?.sourceReferences.some((reference) => reference.sourceId === listing.sourceId
            && sameApplicationUrl(reference.applyUrl, normalizedUrl));
        const preserveLegacyAdmission = Boolean(existing && !existing.admission
          && (knownLegacyDestination || identityMerged)
          && !listing.employerEvidence?.canonicalEmployer);
        const admissionManaged = supportsAdmission && !preserveLegacyAdmission;
        const attribution = await this.attribute(listing);
        if (listing.seasonSource === 'source-default'
          && existing?.applicationPageMetadataVersion === applicationPageMetadataVersion
          && !isPastSeason(existing.season, this.now())) {
          listing = { ...listing, season: existing.season, seasonSource: 'posting' };
        }
        let reachability: Reachability = 'implied';
        let described: boolean | undefined;
        let pageEvidence: ApplicationPageEvidence | undefined;
        const needsMetadataValidation = listing.seasonSource === 'source-default'
          && existing?.applicationPageMetadataVersion !== applicationPageMetadataVersion;
        const destinationRule = admissionManaged && listing.providerIdentity && this.catalogAdmissionResolver
          ? await this.catalogAdmissionResolver.resolveDestinationRule(listing.providerIdentity, listing.applyUrl)
          : undefined;
        const initialDestination = classifyDestination({ listing, reachability, inspectedAt: this.now().toISOString(), ...(destinationRule ? { rule: destinationRule } : {}) });
        const needsPostingAttribution = listing.provenance === 'reviewed-community' && attribution === 'unattributed';
        // Standard provider routes are proven by immutable IDs. Custom routes
        // need page evidence even when the provider API attributed the posting.
        const needsValidation = Boolean(this.validateApplicationUrl && listing.technical !== false
          && (admissionManaged ? initialDestination.classification === 'unresolved' || needsPostingAttribution : attribution === 'unattributed')
          && existing?.invalidApplicationUrl !== normalizedUrl
          && (needsMetadataValidation || needsPostingAttribution || !existing?.applicationUrlValidatedAt || existing.normalizedUrl !== normalizedUrl));
        if (needsValidation) {
          try {
            const validation = await this.validateApplicationUrl!(listing.applyUrl);
            if (typeof validation === 'string') reachability = 'live';
            else {
              pageEvidence = validation.evidence;
              const confidence = assessApplicationPageForListing(listing.title, validation.evidence);
              reachability = reachabilityFromSignals(confidence.signals);
              described = confidence.recommendation === 'alert-eligible';
              const titleSeason = inferSeason(listing.title, '', this.now());
              const pageSeason = inferSeason(
                validation.evidence.title ?? '',
                [validation.evidence.description, validation.evidence.contentExcerpt].filter(Boolean).join(' '),
                this.now(),
              );
              const verifiedSeason = titleSeason !== 'ongoing' ? titleSeason : pageSeason;
              if (verifiedSeason !== 'ongoing') listing = { ...listing, season: verifiedSeason, seasonSource: 'posting' };
              metadataValidated.set(id, applicationPageMetadataVersion);
            }
          } catch (error) {
            reachability = reachabilityFromFailure(error);
            failures[slot] = `${listing.sourceId}: row ${listing.row}: ${error instanceof Error ? error.message : String(error)}`;
            if (!admissionManaged) {
              if (existing?.open && reachability === 'gone') await this.quarantine(existing);
              return;
            }
          }
        }
        const verification = verifyApplication({ attribution, reachability, ...(described === undefined ? {} : { described }) });
        if (!admissionManaged) {
          if (attribution !== 'unattributed' || (needsValidation && verification.alertEligible)) validatedAt.set(id, this.now().toISOString());
          if (verification.alertEligible) alertEligible.add(id);
          resolved.set(id, existing);
          accepted[slot] = listing;
          return;
        }
        const inspectedAt = this.now().toISOString();
        const observedDestination = classifyDestination({ listing, reachability, ...(pageEvidence ? { evidence: pageEvidence } : {}), inspectedAt,
          ...(destinationRule ? { rule: destinationRule } : {}) });
        // Explicit reviewed decisions remain authoritative when configuration
        // changes. Browser evidence may only supplement an unresolved route or
        // satisfy a rule that specifically requires browser inspection.
        const browserDestination = listing.providerIdentity
          && (!destinationRule || destinationRule.decision === 'browser-required')
          ? matchingBrowserDestination(existing, {
            sourceId: listing.sourceId, externalId: id, providerIdentity: listing.providerIdentity, candidateUrl: listing.applyUrl,
          })
          : undefined;
        const destination = browserDestination ?? observedDestination;
        const admission = evaluateCatalogAdmission({
          listing,
          destination,
          postingAttributed: listing.provenance !== 'reviewed-community' || attribution !== 'unattributed' || described === true
            || existing?.sourceReferences.some((reference) => reference.sourceId === listing.sourceId && reference.externalId === id
              && reference.admission?.postingAttribution === 'attributed') === true,
          evaluatedAt: inspectedAt,
          previous: existing?.admission,
        });
        // Activating reviewed employer mappings must not hide a previously
        // visible exact-URL role merely because its per-posting browser check
        // has not run yet. It receives no new alert and remains legacy-managed
        // until the queued verifier supplies attribution. New rows still fail
        // closed through the normal admission decision above.
        const preserveLegacyWhileAttributionPending = Boolean(existing && !existing.admission
          && knownLegacyDestination && listing.provenance === 'reviewed-community'
          && destination.classification === 'posting-detail'
          && admission.reasonCodes.length === 1 && admission.reasonCodes[0] === 'posting-unattributed');
        if (!preserveLegacyWhileAttributionPending) listing = { ...listing, admission };
        const needsPostingAttributionVerification = admission.reasonCodes.includes('posting-unattributed')
          && ['posting-detail', 'application-form'].includes(destination.classification);
        if (!browserDestination && this.enqueueDestinationVerification && listing.providerIdentity
          && (requiresBrowserVerification(destination) || needsPostingAttributionVerification)) {
          await this.enqueueDestinationVerification({
            jobId: listing.postingIdentity?.canonicalJobId ?? stableSourceOccurrenceJobId(listing.sourceId, id),
            sourceId: listing.sourceId,
            externalId: id,
            providerIdentity: listing.providerIdentity,
            candidateUrl: listing.applyUrl,
            reason: existing?.normalizedUrl && existing.normalizedUrl !== normalizedUrl ? 'url-change' : 'first-sight',
          });
        }
        if (admission.catalogEligible && ['posting-detail', 'application-form'].includes(destination.classification)) {
          validatedAt.set(id, this.now().toISOString());
        }
        if (admission.alertEligible) alertEligible.add(id);
        resolved.set(id, existing);
        accepted[slot] = listing;
      } catch (error) {
        failures[slot] = `${listing.sourceId}: row ${listing.row}: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    report.failures.push(...failures.filter((failure): failure is string => failure !== undefined));
    return {
      accepted: accepted.filter((listing): listing is ProcessedListing => listing !== undefined),
      resolved,
      validatedAt,
      metadataValidated,
      alertEligible,
    };
  }

  async run(options: { seedOnly?: boolean; runId?: string; allowCompleteEmptySnapshot?: boolean } = {}): Promise<PollReport> {
    const report: PollReport = {
      fetchedSources: 0,
      unchangedSources: [],
      baselineSources: [],
      processedListings: 0,
      newJobs: [],
      filteredJobs: [],
      quarantinedListings: [],
      failures: [],
    };
    const health: SourceHealth[] = [];
    this.boardActiveIds.clear();
    this.boardCheckpoints = undefined;
    this.currentRunGreenhouseActiveIds.clear();
    const reviewedGreenhouseSourceIds = new Set([...new Set(this.boardIndex.values())]
      .filter((sourceId) => providerEvidenceForOccurrence(sourceId, '1')?.provider === 'greenhouse'));
    const prefetchedBoards = new Map<string, PrefetchedBoardFetch>();
    // Fetch every reviewed Greenhouse connector before resolving any listing.
    // Tenant-less embed aliases are safe only when uniqueness includes all
    // current snapshots, including boards processed later in this run.
    for (const connector of this.connectors) {
      if (!reviewedGreenhouseSourceIds.has(connector.id)) continue;
      const prefetched: PrefetchedBoardFetch = {
        attemptedAt: this.now().toISOString(),
        started: Date.now(),
      };
      prefetchedBoards.set(connector.id, prefetched);
      try {
        prefetched.previous = await this.store.getCheckpoint(connector.id);
        prefetched.admissionConfigurationVersion = await this.catalogAdmissionResolver?.configurationVersion?.();
        const configurationChanged = Boolean(prefetched.admissionConfigurationVersion
          && prefetched.previous?.admissionConfigurationVersion
          && prefetched.admissionConfigurationVersion !== prefetched.previous.admissionConfigurationVersion);
        const fetchCheckpoint = configurationChanged && prefetched.previous ? {
          ...prefetched.previous,
          etag: undefined,
          documentEtags: undefined,
          contentHash: undefined,
        } : prefetched.previous;
        prefetched.result = await fetchWithRetry(connector, fetchCheckpoint);
        const qualityFailures = sourceQualityFailures(prefetched.result, prefetched.previous, {
          allowCompleteEmptySnapshot: options.allowCompleteEmptySnapshot && isSourceSnapshot(prefetched.result),
        });
        if (!qualityFailures.length) {
          const activeExternalIds = isSourceSnapshot(prefetched.result)
            ? prefetched.result.checkpoint.activeExternalIds ?? prefetched.result.postings.map((posting) => posting.externalId)
            : prefetched.result.checkpoint.activeExternalIds ?? prefetched.result.listings.map(externalId);
          this.currentRunGreenhouseActiveIds.set(connector.id, new Set(activeExternalIds));
        }
      } catch (error) {
        prefetched.error = error;
      }
    }
    for (const connector of this.connectors) {
      const prefetched = prefetchedBoards.get(connector.id);
      const attemptedAt = prefetched?.attemptedAt ?? this.now().toISOString();
      const started = prefetched?.started ?? Date.now();
      const previous = prefetched ? prefetched.previous : await this.store.getCheckpoint(connector.id);
      const previousHealth = await this.store.getSourceHealth(connector.id);
      let failureCategory: NonNullable<SourceHealth['diagnosticCategory']> = 'transport';
      try {
        if (prefetched?.error) throw prefetched.error;
        const admissionConfigurationVersion = prefetched
          ? prefetched.admissionConfigurationVersion
          : await this.catalogAdmissionResolver?.configurationVersion?.();
        const admissionConfigurationChanged = Boolean(admissionConfigurationVersion
          && previous?.admissionConfigurationVersion
          && admissionConfigurationVersion !== previous.admissionConfigurationVersion);
        const fetchCheckpoint = admissionConfigurationChanged && previous ? {
          ...previous,
          etag: undefined,
          documentEtags: undefined,
          contentHash: undefined,
        } : previous;
        const result = prefetched?.result ?? await fetchWithRetry(connector, fetchCheckpoint);
        report.fetchedSources += 1;
        failureCategory = 'quality';
        const qualityFailures = sourceQualityFailures(result, previous, {
          allowCompleteEmptySnapshot: options.allowCompleteEmptySnapshot && isSourceSnapshot(result),
        });
        if (qualityFailures.length) throw new SourceFetchError(qualityFailures.join('; '), 'empty');
        const batch = isSourceSnapshot(result) ? neutralBatch(result) : legacyBatch(result);
        if (batch.unchanged) report.unchangedSources.push(connector.id);
        const baseline = Boolean(!previous || previous.successfulFetches === 0 || options.seedOnly);
        if (baseline) report.baselineSources.push(connector.id);
        report.processedListings += batch.processed.counts.eligible;
        const now = this.now().toISOString();
        const priorOccurrences = await this.store.getSourceOccurrences(connector.id);
        // An unchanged snapshot repeats postings the checkpoint already trusts, so
        // only omission progress is reconciled; re-resolving every row would cost a
        // full catalog rewrite on every poll for byte-identical source content.
        const githubAdmissionConfigurationVersion = providerFor(connector.id) === 'github'
          ? admissionConfigurationVersion
          : undefined;
        const resolution = await this.resolveListings(
          batch.unchanged ? [] : batch.processed.listings,
          report,
          priorOccurrences,
          githubAdmissionConfigurationVersion,
          Boolean(githubAdmissionConfigurationVersion
            && admissionConfigurationVersion === previous?.admissionConfigurationVersion),
        );
        const closureCandidates = priorOccurrences.filter((prior) => !resolution.resolved.has(prior.externalId)
          && !batch.activeExternalIds.has(prior.externalId)
          && prior.consecutiveOmissions >= 1);
        await forEachBounded(closureCandidates, async (prior) => {
          resolution.resolved.set(prior.externalId, await this.store.getJob(prior.jobId));
        });
        const plan = this.reconciler.reconcile({
          sourceId: connector.id,
          snapshotHash: batch.snapshotHash,
          activeExternalIds: batch.activeExternalIds,
          listings: resolution.accepted,
          priorOccurrences,
          resolvedJobs: resolution.resolved,
          now,
          baseline,
          filter: this.filter,
          validatedAt: resolution.validatedAt,
          metadataValidated: resolution.metadataValidated,
          alertEligible: resolution.alertEligible,
          publishUnconfirmedIdentities: this.publishUnconfirmedIdentities,
        });
        failureCategory = 'persistence';
        const notificationByJobId = new Map(plan.notifications.map((event) => [event.jobId, event]));
        const plannedJobs = new Map(plan.jobs.map((job) => [job.jobId, job]));
        const committedJobIds = new Set<string>();
        const blockedJobIds = new Set<string>();
        const alertedJobIds = new Set<string>();
        const notificationErrors = new Array<unknown>(plan.notifications.length);
        const consumedEvents = new Set<string>();
        const classifiedEventIds = new Set<string>();
        await forEachBounded(plan.occurrences, async (occurrence) => {
          const job = plannedJobs.get(occurrence.jobId);
          const decision = occurrence.occurrence.postingIdentityDecision;
          if (!job || !decision || decision.status === 'quarantined') {
            await this.store.putSourceOccurrence(occurrence);
            return;
          }
          const event = notificationByJobId.get(job.jobId);
          // Every classified occurrence for the canonical job may carry the
          // same deterministic event. The transaction/outbox uniqueness
          // boundary chooses the inserter, so one failed sibling cannot leave
          // a successfully committed job without its alert tombstone.
          const includeEvent = event;
          if (includeEvent) classifiedEventIds.add(includeEvent.eventId);
          try {
            const result = await this.store.commitPostingObservation({
              decision,
              ...(job.postingIdentity ? { identity: job.postingIdentity } : {}),
              job,
              occurrence,
              ...(includeEvent ? { notificationEvent: includeEvent } : {}),
            });
            if (result.outcome === 'quarantined') {
              blockedJobIds.add(job.jobId);
              report.quarantinedListings.push({
                sourceId: occurrence.sourceId,
                row: occurrence.occurrence.row,
                reason: `posting identity conflict (${result.incident.decision.reason})`,
              });
              return;
            }
            committedJobIds.add(job.jobId);
            if (includeEvent) {
              consumedEvents.add(includeEvent.eventId);
              if (result.notificationInserted) alertedJobIds.add(job.jobId);
            }
          } catch (error) {
            if (includeEvent) notificationErrors[plan.notifications.indexOf(includeEvent)] = error;
            else throw error;
          }
        });
        await forEachBounded(
          plan.jobs.filter((job) => !committedJobIds.has(job.jobId) && !blockedJobIds.has(job.jobId) && !notificationByJobId.has(job.jobId)),
          (job) => this.store.putInternship(job),
        );
        // Legacy-unclassified plans retain the compatible job+event operation.
        await forEachBounded(plan.notifications.filter((event) => !classifiedEventIds.has(event.eventId) && !consumedEvents.has(event.eventId) && !blockedJobIds.has(event.jobId)), async (event, index) => {
          const job = plannedJobs.get(event.jobId);
          if (!job) { notificationErrors[index] = new Error(`Notification event ${event.eventId} has no catalog job`); return; }
          try { if (await this.store.putInternshipWithNotificationEvent(job, event)) alertedJobIds.add(event.jobId); }
          catch (error) { notificationErrors[index] = error; }
        });
        for (const job of plan.newJobs) {
          if (alertedJobIds.has(job.jobId)) report.newJobs.push(job);
        }
        const notificationError = notificationErrors.find((error) => error !== undefined);
        if (notificationError) throw notificationError;
        const provider = providerFor(connector.id);
        const unchanged304 = result.unchangedReason === 'not_modified';
        const metricCounts: ProcessedSnapshot['counts'] = unchanged304 ? {
          raw: previous?.lastRawCount ?? previous?.lastRawRowCount ?? previousHealth?.rawRows ?? batch.processed.counts.raw,
          valid: previousHealth?.validRows ?? batch.processed.counts.valid,
          eligible: previous?.lastRowCount ?? previousHealth?.eligibleRows ?? batch.processed.counts.eligible,
          shelved: previousHealth?.counts?.shelved ?? batch.processed.counts.shelved,
          filtered: previousHealth?.filteredRows ?? batch.processed.counts.filtered,
          withheld: previous?.lastWithheldRowCount ?? previousHealth?.withheldRows ?? batch.processed.counts.withheld,
        } : batch.processed.counts;
        const successHealth: SourceHealth = {
          ...successfulSourceHealth({
            sourceId: connector.id,
            provider,
            region: regionFor(provider),
            previous: previousHealth,
            startedAt: attemptedAt,
            completedAt: now,
            runId: options.runId,
            outcome: batch.unchanged
              ? (result.unchangedReason === 'not_modified' ? 'success_unchanged_304' : 'success_unchanged_hash')
              : 'success_changed',
            etag: result.checkpoint.etag,
            contentHash: batch.snapshotHash,
            rawRows: metricCounts.raw,
            validRows: metricCounts.valid,
            eligibleRows: metricCounts.eligible,
            filteredRows: metricCounts.filtered,
            withheldRows: metricCounts.withheld,
          }),
          counts: metricCounts,
        };
        await this.store.putSourceHealth(successHealth);
        health.push(successHealth);
        await this.store.putCheckpoint({
          ...result.checkpoint,
          contentHash: batch.snapshotHash,
          activeExternalIds: [...batch.activeExternalIds],
          ...(admissionConfigurationVersion ? { admissionConfigurationVersion } : {}),
        });
        for (const job of plan.newJobs) {
          if (!alertedJobIds.has(job.jobId)) {
            console.log(JSON.stringify({ event: 'new_job_alert_suppressed', sourceId: connector.id, jobId: job.jobId }));
          }
        }
        report.filteredJobs.push(...plan.filteredJobs);
        emitSuccessMetric(
          connector.id,
          providerFor(connector.id),
          batch.unchanged
            ? result.unchangedReason === 'not_modified' ? 'success_unchanged_304' : 'success_unchanged_hash'
            : 'success_changed',
          metricCounts,
          Date.now() - started,
          result.conditionalRequest,
          options.runId,
        );
      } catch (error) {
        const category = error instanceof SourceFetchError ? error.category : failureCategory;
        const provider = providerFor(connector.id);
        const failureHealth: SourceHealth = {
          ...failedSourceHealth({
            sourceId: connector.id,
            provider,
            region: regionFor(provider),
            previous: previousHealth,
            startedAt: attemptedAt,
            completedAt: this.now().toISOString(),
            runId: options.runId,
            error,
          }),
          diagnosticCategory: category,
        };
        health.push(failureHealth);
        try { await this.store.putSourceHealth(failureHealth); }
        catch { /* The original source/persistence failure remains primary. */ }
        report.failures.push(error instanceof Error ? error.message : String(error));
        emitFailureMetric(
          connector.id,
          providerFor(connector.id),
          category,
          Date.now() - started,
          sourceFailureOutcome(error),
          options.runId,
        );
      }
    }
    emitFreshnessMetric(health, this.now());
    await this.validateUnverifiedOpenJobs(report);
    return report;
  }
}

/** @deprecated Compatibility facade; new code should construct `IngestionRunner`. */
export class Poller extends IngestionRunner {
  poll(options: { seedOnly?: boolean; runId?: string; allowCompleteEmptySnapshot?: boolean } = {}) {
    return this.run(options);
  }
}
