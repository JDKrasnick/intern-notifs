import { createHash } from 'node:crypto';
import { assessApplicationPageForListing, canonicalApplicationUrl, type ApplicationPageConfidence, type ApplicationUrlValidator } from './core/application-url.js';
import { fingerprintCandidates, normalizeUrl } from './core/normalize.js';
import { isTechnicalJob, type JobFilter } from './core/filters.js';
import { CatalogReconciler } from './ingestion/catalog-reconciler.js';
import { processSnapshot } from './ingestion/processor.js';
import { sourceQualityFailures } from './sources/quality.js';
import { SourceFetchError } from './sources/source-error.js';
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

function providerFor(sourceId: string): SourceHealth['provider'] {
  if (sourceId.startsWith('lever-')) return 'lever';
  if (sourceId.includes('greenhouse-')) return 'greenhouse';
  return sourceId ? 'github' : 'unknown';
}

function emitSuccessMetric(sourceId: string, provider: SourceHealth['provider'], outcome: 'changed' | 'unchanged', counts: ProcessedSnapshot['counts'], durationMs: number) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['provider', 'outcome']],
        Metrics: [
          { Name: 'SourceFetchSuccess', Unit: 'Count' },
          { Name: 'SourceFetchDurationMs', Unit: 'Milliseconds' },
          { Name: 'RawListingCount', Unit: 'Count' },
          { Name: 'EligibleListingCount', Unit: 'Count' },
          { Name: 'ListingWithheld', Unit: 'Count' },
        ],
      }],
    },
    event: 'source_ingestion_completed',
    sourceId,
    provider,
    outcome,
    SourceFetchSuccess: 1,
    SourceFetchDurationMs: durationMs,
    RawListingCount: counts.raw,
    EligibleListingCount: counts.eligible,
    ListingWithheld: counts.withheld,
    counts,
  }));
}

function emitFailureMetric(sourceId: string, provider: SourceHealth['provider'], category: NonNullable<SourceHealth['diagnosticCategory']>, durationMs: number) {
  console.error(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['provider', 'category']],
        Metrics: [
          { Name: 'SourceFetchFailure', Unit: 'Count' },
          { Name: 'SourceFetchDurationMs', Unit: 'Milliseconds' },
        ],
      }],
    },
    event: 'source_ingestion_failed',
    sourceId,
    provider,
    category,
    SourceFetchFailure: 1,
    SourceFetchDurationMs: durationMs,
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
        eligible: listings.length,
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
  const processed = processSnapshot(result);
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
      await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** (attempt - 1))));
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
          await this.quarantine(job);
          report.failures.push(`catalog: ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(24, jobs.length) }, async () => {
        while (nextJob < jobs.length) await validateJob();
      }));
    } while (cursor);
  }

  private async resolveListings(listings: ProcessedListing[], report: PollReport) {
    const resolved = new Map<string, Internship | undefined>();
    const validatedAt = new Map<string, string>();
    const alertEligible = new Set<string>();
    const accepted: ProcessedListing[] = [];
    for (const sourceListing of listings) {
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
        let confidence: ApplicationPageConfidence | undefined;
        const needsValidation = Boolean(this.validateApplicationUrl && existing?.invalidApplicationUrl !== normalizedUrl
          && (!existing?.applicationUrlValidatedAt || existing.normalizedUrl !== normalizedUrl));
        validatingLink = needsValidation;
        if (needsValidation) {
          const validation = await this.validateApplicationUrl!(listing.applyUrl);
          if (typeof validation !== 'string') confidence = assessApplicationPageForListing(listing.title, validation.evidence);
        }
        if (needsValidation && confidence?.level !== 'low') validatedAt.set(id, this.now().toISOString());
        validatingLink = false;
        if (confidence?.recommendation !== 'catalog-only' && confidence?.recommendation !== 'review') alertEligible.add(id);
        resolved.set(id, existing);
        accepted.push(listing);
      } catch (error) {
        if (validatingLink && existing?.open) await this.quarantine(existing);
        report.failures.push(`${listing.sourceId}: row ${listing.row}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { accepted, resolved, validatedAt, alertEligible };
  }

  async run(options: { seedOnly?: boolean } = {}): Promise<PollReport> {
    const report: PollReport = { fetchedSources: 0, unchangedSources: [], baselineSources: [], processedListings: 0, newJobs: [], filteredJobs: [], failures: [] };
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
        report.processedListings += batch.processed.listings.length;
        const now = this.now().toISOString();
        const priorOccurrences = await this.store.getSourceOccurrences(connector.id);
        const resolution = await this.resolveListings(batch.processed.listings, report);
        for (const prior of priorOccurrences) {
          if (!resolution.resolved.has(prior.externalId)) resolution.resolved.set(prior.externalId, await this.store.getJob(prior.jobId));
        }
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
        for (const job of plan.jobs) await this.store.putInternship(job);
        for (const occurrence of plan.occurrences) await this.store.putSourceOccurrence(occurrence);
        for (const event of plan.notifications) await this.store.putNotificationEvent(event);
        await this.store.putSourceHealth({
          sourceId: connector.id,
          provider: providerFor(connector.id),
          lastAttemptAt: attemptedAt,
          lastSuccessAt: now,
          outcome: batch.unchanged ? 'unchanged' : 'changed',
          durationMs: Date.now() - started,
          snapshotHash: batch.snapshotHash,
          counts: batch.processed.counts,
          consecutiveFailures: 0,
        });
        await this.store.putCheckpoint({
          ...result.checkpoint,
          contentHash: batch.snapshotHash,
          activeExternalIds: [...batch.activeExternalIds],
        });
        report.newJobs.push(...plan.newJobs);
        report.filteredJobs.push(...plan.filteredJobs);
        emitSuccessMetric(connector.id, providerFor(connector.id), batch.unchanged ? 'unchanged' : 'changed', batch.processed.counts, Date.now() - started);
      } catch (error) {
        const category = error instanceof SourceFetchError ? error.category : failureCategory;
        try {
          await this.store.putSourceHealth({
            sourceId: connector.id,
            provider: providerFor(connector.id),
            lastAttemptAt: attemptedAt,
            lastSuccessAt: previousHealth?.lastSuccessAt,
            outcome: 'failed',
            durationMs: Date.now() - started,
            consecutiveFailures: (previousHealth?.consecutiveFailures ?? 0) + 1,
            diagnosticCategory: category,
          });
        } catch { /* The original source/persistence failure remains primary. */ }
        report.failures.push(error instanceof Error ? error.message : String(error));
        emitFailureMetric(connector.id, providerFor(connector.id), category, Date.now() - started);
      }
    }
    await this.validateUnverifiedOpenJobs(report);
    return report;
  }
}

/** @deprecated Compatibility facade; new code should construct `IngestionRunner`. */
export class Poller extends IngestionRunner {
  poll(options: { seedOnly?: boolean } = {}) {
    return this.run(options);
  }
}
