import { fingerprint, fingerprintCandidates, jobId, normalizeUrl } from './core/normalize.js';
import type { ApplicationUrlValidator } from './core/application-url.js';
import { isTechnicalJob, matchesJobFilter, type JobFilter } from './core/filters.js';
import { employerCategory } from './core/employers.js';
import type { Internship, RawListing, SourceAdapter, SourceOccurrence } from './types.js';
import type { InternshipStore } from './store.js';

export interface PollReport { fetchedSources: number; baselineSources: string[]; newJobs: Internship[]; filteredJobs: Internship[]; failures: string[]; }

function occurrence(listing: RawListing): SourceOccurrence {
  return { sourceId: listing.sourceId, document: listing.document, sourceUrl: listing.sourceUrl, row: listing.row, postedAt: listing.postedAt, company: listing.company, title: listing.title, location: listing.location, season: listing.season, applyUrl: listing.applyUrl, compensation: listing.compensation, ...(listing.requirements ? { requirements: listing.requirements } : {}), state: listing.state };
}
function genericLocation(value: string | undefined) {
  return !value || /^(unknown|unspecified|n\/?a|not (?:listed|specified)|tbd|see (?:description|job))$/i.test(value.trim());
}
function merge(existing: Internship, listing: RawListing, now: string, applicationUrlValidatedAt?: string): Internship {
  const reference = occurrence(listing);
  const match = existing.sourceReferences.findIndex((item) => item.sourceId === reference.sourceId && item.document === reference.document && item.row === reference.row);
  // Keep the first precise source value stable; secondary lists often flatten
  // details such as “Remote (US)” into a less useful variant.
  const location = genericLocation(existing.location) ? listing.location || existing.location : existing.location;
  const company = existing.company || listing.company;
  const sourceReferences = match >= 0 ? existing.sourceReferences.map((item, index) => index === match ? reference : item) : [...existing.sourceReferences, reference];
  const replaceLegacyUrl = Boolean(applicationUrlValidatedAt && !existing.applicationUrlValidatedAt);
  return { ...existing, company, title: existing.title || listing.title, location, applyUrl: replaceLegacyUrl ? listing.applyUrl : existing.applyUrl || listing.applyUrl, normalizedUrl: replaceLegacyUrl ? normalizeUrl(listing.applyUrl) : existing.normalizedUrl, fingerprint: fingerprint(company, existing.title || listing.title, location, listing.season), compensation: listing.compensation.maxHourlyUSD ? listing.compensation : existing.compensation, requirements: listing.requirements ?? existing.requirements, employerCategory: employerCategory(company), sourceReferences, open: sourceReferences.some((item) => item.state === 'open'), lastSeenAt: now, ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}) };
}
function newJob(listing: RawListing, now: string, applicationUrlValidatedAt?: string): Internship {
  const normalizedUrl = normalizeUrl(listing.applyUrl); const key = fingerprint(listing.company, listing.title, listing.location, listing.season);
  return { jobId: jobId(normalizedUrl, key), company: listing.company, title: listing.title, location: listing.location, season: listing.season, applyUrl: listing.applyUrl, normalizedUrl, ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}), fingerprint: key, compensation: listing.compensation, ...(listing.requirements ? { requirements: listing.requirements } : {}), employerCategory: employerCategory(listing.company), sourceReferences: [occurrence(listing)], open: listing.state === 'open', firstSeenAt: now, lastSeenAt: now, notification: { smsPending: true, digestPending: true } };
}

export class Poller {
  constructor(private readonly adapters: SourceAdapter[], private readonly store: InternshipStore, private readonly now: () => Date = () => new Date(), private readonly filter?: JobFilter, private readonly validateApplicationUrl?: ApplicationUrlValidator) {}
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
          await this.store.putInternship({ ...job, open: false, notification: { ...job.notification, smsPending: false, digestPending: false } });
          report.failures.push(`catalog: ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(24, jobs.length) }, async () => {
        while (nextJob < jobs.length) await validateJob();
      }));
    } while (cursor);
  }
  async poll(options: { seedOnly?: boolean } = {}): Promise<PollReport> {
    const report: PollReport = { fetchedSources: 0, baselineSources: [], newJobs: [], filteredJobs: [], failures: [] };
    for (const adapter of this.adapters) {
      const previous = await this.store.getCheckpoint(adapter.id);
      try {
        const result = await adapter.fetch(previous); report.fetchedSources += 1;
        if (result.notModified) continue;
        // A formerly healthy feed returning no rows is more likely layout drift than no internships.
        if ((previous?.successfulFetches ?? 0) > 0 && previous?.lastRowCount && result.listings.length === 0) throw new Error(`${adapter.id}: suspicious zero-row parser result`);
        const baseline = !previous || previous.successfulFetches === 0 || options.seedOnly;
        if (baseline) report.baselineSources.push(adapter.id);
        const now = this.now().toISOString();
        let nextListing = 0;
        const processListing = async () => {
          const listing = result.listings[nextListing++];
          if (!listing) return;
          let existing: Internship | undefined;
          let validatingLink = false;
          try {
            const normalizedUrl = normalizeUrl(listing.applyUrl);
            existing = await this.store.findByUrl(normalizedUrl);
            for (const candidate of fingerprintCandidates(listing.company, listing.title, listing.location, listing.season)) {
              if (existing) break;
              existing = await this.store.findByFingerprint(candidate);
            }
            // Runtime polling supplies a live verifier. Existing validated URLs
            // are cached so the five-minute poll does not repeatedly probe the
            // same employer endpoint.
            const needsValidation = Boolean(this.validateApplicationUrl && (!existing?.applicationUrlValidatedAt || existing.normalizedUrl !== normalizedUrl));
            validatingLink = needsValidation;
            if (needsValidation) await this.validateApplicationUrl!(listing.applyUrl);
            const verifiedListing = listing;
            const validatedAt = needsValidation ? now : undefined;
            validatingLink = false;
            if (existing) await this.store.putInternship(merge(existing, verifiedListing, now, validatedAt));
            else {
              const created = newJob(verifiedListing, now, validatedAt);
              if (baseline) created.notification = { smsPending: false, digestPending: false };
              else if (created.open && isTechnicalJob(created) && matchesJobFilter(created, this.filter)) report.newJobs.push(created);
              else { created.notification = { smsPending: false, digestPending: false }; report.filteredJobs.push(created); }
              await this.store.putInternship(created);
            }
          } catch (error) {
            if (validatingLink && existing?.open) {
              await this.store.putInternship({ ...existing, open: false, notification: { ...existing.notification, smsPending: false, digestPending: false } });
            }
            report.failures.push(`${adapter.id}: row ${listing.row}: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        const workers = Array.from({ length: Math.min(24, result.listings.length) }, async () => {
          while (nextListing < result.listings.length) await processListing();
        });
        await Promise.all(workers);
        await this.store.putCheckpoint(result.checkpoint);
      } catch (error) { report.failures.push(error instanceof Error ? error.message : String(error)); }
    }
    await this.validateUnverifiedOpenJobs(report);
    return report;
  }
}
