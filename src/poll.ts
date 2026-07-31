import { createHash } from 'node:crypto';
import { assessApplicationPageForListing, canonicalApplicationUrl, type ApplicationUrlValidator } from './core/application-url.js';
import { boardReference, reachabilityFromFailure, reachabilityFromSignals, verifyApplication, type AttributionBasis, type Reachability } from './core/application-verification.js';
import { fingerprintCandidates, normalizeUrl } from './core/normalize.js';
import { isTechnicalJob, type JobFilter } from './core/filters.js';
import { CatalogReconciler } from './ingestion/catalog-reconciler.js';
import { evaluateSourceFreshness } from './ingestion/monitoring.js';
import { processSnapshot } from './ingestion/processor.js';
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
  SourceSnapshot,
} from './types.js';
import type { InternshipStore } from './store.js';

export interface PollReport {
  fetchedSources: number;
  unchangedSources: string[];
  baselineSources: string[];
  processedListings: number;
  newJobs: Internship[];
  filteredJobs: Internship[];
  failures: string[];
}

interface TrustedBatch {
  fetchResult: SourceFetchResult;
  processed: ProcessedSnapshot;
  snapshotHash: string;
  activeExternalIds: Set<string>;
  unchanged: boolean;
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
  if (sourceId.startsWith('lever-')) return 'lever';
  if (sourceId.includes('greenhouse-')) return 'greenhouse';
  return sourceId ? 'github' : 'unknown';
}

function regionFor(provider: SourceHealth['provider']): NonNullable<SourceHealth['region']> {
  return provider === 'lever' ? 'global' : 'unknown';
}

function emitSuccessMetric(
  sourceId: string,
  provider: SourceHealth['provider'],
  outcome: 'success_changed' | 'success_unchanged_304' | 'success_unchanged_hash',
  counts: ProcessedSnapshot['counts'],
  durationMs: number,
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
    counts,
  }));
}

function emitFreshnessMetric(records: SourceHealth[], now: Date) {
  const freshness = evaluateSourceFreshness(records, now);
  const polled = new Set(records.map((record) => record.provider));
  for (const [provider, staleCount] of Object.entries(freshness.byProvider).filter(([name]) => polled.has(name as SourceHealth['provider']))) {
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
    if (!this.validateApplicationUrl || !this.store.listOpen) return;
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
          await this.validateApplicationUrl!(job.applyUrl);
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

  /**
   * A posting served by a reviewed connector is attributed by its own URL
   * contract. A posting merely referenced by a list is attributed when the board
   * it points at is one this catalog polls and that board's checkpoint still
   * lists it — evidence already held, so no employer request is made.
   */
  private async attribute(listing: ProcessedListing): Promise<AttributionBasis> {
    if ([...this.boardIndex.values()].includes(listing.sourceId)) return 'provider-api';
    const reference = boardReference(listing.applyUrl);
    const sourceId = reference && this.boardIndex.get(`${reference.provider}:${reference.token}`);
    if (!reference || !sourceId) return 'unattributed';
    if (!this.boardActiveIds.has(sourceId)) {
      this.boardActiveIds.set(sourceId, this.store.getCheckpoint(sourceId)
        .then((checkpoint) => new Set(checkpoint?.activeExternalIds ?? []))
        .catch(() => new Set<string>()));
    }
    return (await this.boardActiveIds.get(sourceId)!).has(reference.postingId) ? 'reviewed-board' : 'unattributed';
  }

  private async resolveListings(listings: ProcessedListing[], report: PollReport) {
    const resolved = new Map<string, Internship | undefined>();
    const validatedAt = new Map<string, string>();
    const alertEligible = new Set<string>();
    // Slots keep the snapshot order stable so duplicate merging, alert order, and
    // reported failures do not depend on which worker finished first.
    const accepted = new Array<ProcessedListing | undefined>(listings.length);
    const failures = new Array<string | undefined>(listings.length);
    await forEachBounded(listings, async (sourceListing, slot) => {
      const canonicalUrl = canonicalApplicationUrl(sourceListing.applyUrl);
      const listing = {
        ...sourceListing,
        externalId: externalId(sourceListing),
        applyUrl: canonicalUrl,
        technical: sourceListing.technical ?? true,
      };
      const id = listing.externalId;
      let existing: Internship | undefined;
      let validatingLink = false;
      try {
        const normalizedUrl = normalizeUrl(listing.applyUrl);
        existing = await this.store.findByUrl(normalizedUrl);
        for (const candidate of fingerprintCandidates(listing.company, listing.title, listing.location, listing.season)) {
          if (existing) break;
          existing = await this.store.findByFingerprint(candidate);
        }
        const attribution = await this.attribute(listing);
        let reachability: Reachability = 'implied';
        let described: boolean | undefined;
        // Attribution already proves the destination, and shelved roles never
        // surface, so neither is worth an employer request.
        const needsValidation = Boolean(this.validateApplicationUrl && listing.technical !== false
          && attribution === 'unattributed'
          && existing?.invalidApplicationUrl !== normalizedUrl
          && (!existing?.applicationUrlValidatedAt || existing.normalizedUrl !== normalizedUrl));
        validatingLink = needsValidation;
        if (needsValidation) {
          const validation = await this.validateApplicationUrl!(listing.applyUrl);
          if (typeof validation === 'string') reachability = 'live';
          else {
            const confidence = assessApplicationPageForListing(listing.title, validation.evidence);
            reachability = reachabilityFromSignals(confidence.signals);
            described = confidence.recommendation === 'alert-eligible';
          }
        }
        validatingLink = false;
        const verification = verifyApplication({ attribution, reachability, ...(described === undefined ? {} : { described }) });
        if (attribution !== 'unattributed' || (needsValidation && verification.alertEligible)) {
          validatedAt.set(id, this.now().toISOString());
        }
        if (verification.alertEligible) alertEligible.add(id);
        resolved.set(id, existing);
        accepted[slot] = listing;
      } catch (error) {
        // Only a destination proven gone hides a live role; a timeout or a
        // refused read leaves it exactly as it was.
        if (validatingLink && existing?.open && reachabilityFromFailure(error) === 'gone') await this.quarantine(existing);
        failures[slot] = `${listing.sourceId}: row ${listing.row}: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    report.failures.push(...failures.filter((failure): failure is string => failure !== undefined));
    return {
      accepted: accepted.filter((listing): listing is ProcessedListing => listing !== undefined),
      resolved,
      validatedAt,
      alertEligible,
    };
  }

  async run(options: { seedOnly?: boolean; runId?: string } = {}): Promise<PollReport> {
    const report: PollReport = { fetchedSources: 0, unchangedSources: [], baselineSources: [], processedListings: 0, newJobs: [], filteredJobs: [], failures: [] };
    const health: SourceHealth[] = [];
    for (const connector of this.connectors) {
      const attemptedAt = this.now().toISOString();
      const started = Date.now();
      const previous = await this.store.getCheckpoint(connector.id);
      const previousHealth = await this.store.getSourceHealth(connector.id);
      let failureCategory: NonNullable<SourceHealth['diagnosticCategory']> = 'transport';
      try {
        const result = await fetchWithRetry(connector, previous);
        report.fetchedSources += 1;
        failureCategory = 'quality';
        const qualityFailures = sourceQualityFailures(result, previous);
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
        const resolution = await this.resolveListings(batch.unchanged ? [] : batch.processed.listings, report);
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
          alertEligible: resolution.alertEligible,
        });
        failureCategory = 'persistence';
        const notificationByJobId = new Map(plan.notifications.map((event) => [event.jobId, event]));
        await forEachBounded(
          plan.jobs.filter((job) => !notificationByJobId.has(job.jobId)),
          (job) => this.store.putInternship(job),
        );
        // A notification-pending job and its outbox event become visible
        // atomically. Successful units are reported even if a later persistence
        // step fails; their deterministic event keeps the retry quiet.
        const alertedJobIds = new Set<string>();
        const notificationErrors = new Array<unknown>(plan.notifications.length);
        const plannedJobs = new Map(plan.jobs.map((job) => [job.jobId, job]));
        await forEachBounded(plan.notifications, async (event, index) => {
          const job = plannedJobs.get(event.jobId);
          if (!job) {
            notificationErrors[index] = new Error(`Notification event ${event.eventId} has no catalog job`);
            return;
          }
          try {
            if (await this.store.putInternshipWithNotificationEvent(job, event)) alertedJobIds.add(event.jobId);
          } catch (error) {
            notificationErrors[index] = error;
          }
        });
        for (const job of plan.newJobs) {
          if (alertedJobIds.has(job.jobId)) report.newJobs.push(job);
        }
        const notificationError = notificationErrors.find((error) => error !== undefined);
        if (notificationError) throw notificationError;
        await forEachBounded(plan.occurrences, (occurrence) => this.store.putSourceOccurrence(occurrence));
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
  poll(options: { seedOnly?: boolean; runId?: string } = {}) {
    return this.run(options);
  }
}
