import { fingerprint, jobId, normalizeUrl } from './core/normalize.js';
import { matchesJobFilter, type JobFilter } from './core/filters.js';
import type { Internship, RawListing, SourceAdapter, SourceOccurrence } from './types.js';
import type { InternshipStore } from './store.js';

export interface PollReport { fetchedSources: number; baselineSources: string[]; newJobs: Internship[]; filteredJobs: Internship[]; failures: string[]; }

function occurrence(listing: RawListing): SourceOccurrence {
  return { sourceId: listing.sourceId, document: listing.document, sourceUrl: listing.sourceUrl, row: listing.row, postedAt: listing.postedAt, company: listing.company, title: listing.title, location: listing.location, season: listing.season, applyUrl: listing.applyUrl, compensation: listing.compensation, state: listing.state };
}
function merge(existing: Internship, listing: RawListing, now: string): Internship {
  const reference = occurrence(listing);
  const match = existing.sourceReferences.find((item) => item.sourceId === reference.sourceId && item.document === reference.document && item.row === reference.row);
  return { ...existing, company: listing.company || existing.company, title: listing.title || existing.title, location: listing.location || existing.location, applyUrl: listing.applyUrl || existing.applyUrl, compensation: listing.compensation.maxHourlyUSD ? listing.compensation : existing.compensation, sourceReferences: match ? existing.sourceReferences : [...existing.sourceReferences, reference], open: true, lastSeenAt: now };
}
function newJob(listing: RawListing, now: string): Internship {
  const normalizedUrl = normalizeUrl(listing.applyUrl); const key = fingerprint(listing.company, listing.title, listing.location, listing.season);
  return { jobId: jobId(normalizedUrl, key), company: listing.company, title: listing.title, location: listing.location, season: listing.season, applyUrl: listing.applyUrl, normalizedUrl, fingerprint: key, compensation: listing.compensation, sourceReferences: [occurrence(listing)], open: true, firstSeenAt: now, lastSeenAt: now, notification: { smsPending: true, digestPending: true } };
}

export class Poller {
  constructor(private readonly adapters: SourceAdapter[], private readonly store: InternshipStore, private readonly now: () => Date = () => new Date(), private readonly filter?: JobFilter) {}
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
        for (const listing of result.listings) {
          let existing = await this.store.findByUrl(normalizeUrl(listing.applyUrl));
          if (!existing) existing = await this.store.findByFingerprint(fingerprint(listing.company, listing.title, listing.location, listing.season));
          if (existing) await this.store.putInternship(merge(existing, listing, now));
          else {
            const created = newJob(listing, now);
            if (baseline) created.notification = { smsPending: false, digestPending: false };
            else if (matchesJobFilter(listing, this.filter)) report.newJobs.push(created);
            else { created.notification = { smsPending: false, digestPending: false }; report.filteredJobs.push(created); }
            await this.store.putInternship(created);
          }
        }
        await this.store.putCheckpoint(result.checkpoint);
      } catch (error) { report.failures.push(error instanceof Error ? error.message : String(error)); }
    }
    return report;
  }
}
