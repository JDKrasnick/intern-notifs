import { createHash } from 'node:crypto';
import { parseInternshipMarkdown, type MarkdownParseOptions } from '../core/markdown.js';
import { normalizeUrl } from '../core/normalize.js';
import { processSnapshot } from '../ingestion/processor.js';
import { applicationUrlRejection } from './quality.js';
import { parseQuantInternshipMarkdown } from './quant.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../types.js';

export interface GitHubDocument { path: string; branch: string; season: string; }
export interface GitHubAdapterOptions { id: string; owner: string; repo: string; documents: GitHubDocument[]; parser?: (markdown: string, options: MarkdownParseOptions) => RawListing[]; fetchImpl?: typeof fetch; }

export function markdownListingToSourcedPosting(listing: RawListing): SourcedPosting {
  return {
    sourceId: listing.sourceId,
    externalId: `${listing.document}:${normalizeUrl(listing.applyUrl)}`,
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    fetchedAt: listing.fetchedAt,
    employer: { name: listing.company, authority: 'source-row' },
    title: listing.title,
    content: [],
    locations: [listing.location],
    applyUrl: listing.applyUrl,
    sourceState: listing.state,
    ...(listing.postedAt ? { publishedAt: listing.postedAt } : {}),
    seasonHint: listing.season,
    compensationText: listing.compensation.raw,
    declaredRequirements: listing.requirements,
    declaredWorkMode: listing.workMode,
  };
}

function postingProjection(postings: SourcedPosting[]): string {
  return JSON.stringify(postings.map(({ fetchedAt: _fetchedAt, row: _row, ...posting }) => posting)
    .sort((a, b) => a.externalId.localeCompare(b.externalId)));
}

type TransitionalMarkdownResult = SourceSnapshot & SourceFetchResult;

export class GitHubMarkdownAdapter implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: GitHubAdapterOptions) { this.id = options.id; this.fetchImpl = options.fetchImpl ?? fetch; }

  async fetch(previous?: SourceCheckpoint): Promise<TransitionalMarkdownResult> {
    const rawListings: RawListing[] = []; const rejectedApplicationUrls: Array<{ row: number; url: string; reason: string }> = []; const documentEtags = { ...previous?.documentEtags }; let etag: string | undefined; let allUnchanged = true;
    for (const document of this.options.documents) {
      const url = `https://raw.githubusercontent.com/${this.options.owner}/${this.options.repo}/${document.branch}/${document.path}`;
      // A 304 supplies no body. Multi-document sources therefore fetch every
      // document so a changed result is always a complete source snapshot.
      const knownEtag = this.options.documents.length === 1
        ? previous?.documentEtags?.[document.path] ?? previous?.etag
        : undefined;
      const response = await this.fetchImpl(url, { headers: knownEtag ? { 'If-None-Match': knownEtag } : {} });
      if (response.status === 304) continue;
      if (!response.ok) throw new Error(`${this.id}: ${document.path} fetch failed (${response.status})`);
      allUnchanged = false; etag = response.headers.get('etag') ?? etag;
      const documentEtag = response.headers.get('etag'); if (documentEtag) documentEtags[document.path] = documentEtag;
      const parsed = (this.options.parser ?? parseInternshipMarkdown)(await response.text(), { sourceId: this.id, document: document.path, sourceUrl: url, season: document.season });
      for (const listing of parsed) {
        const rejection = applicationUrlRejection(listing.applyUrl);
        if (rejection) rejectedApplicationUrls.push({ row: listing.row, url: listing.applyUrl, reason: rejection });
        else rawListings.push(listing);
      }
    }
    if (allUnchanged) {
      return {
        sourceId: this.id,
        outcome: 'unchanged',
        complete: true,
        postings: [],
        rawCount: previous?.lastRowCount ?? 0,
        contentHash: previous?.contentHash ?? '',
        listings: [],
        notModified: true,
        checkpoint: {
          ...previous,
          sourceId: this.id,
          documentEtags,
          lastSuccessAt: new Date().toISOString(),
          successfulFetches: previous?.successfulFetches ?? 0,
        },
      };
    }
    const postings = rawListings.map(markdownListingToSourcedPosting);
    if (new Set(postings.map((posting) => posting.externalId)).size !== postings.length) {
      throw new Error(`${this.id}: duplicate Markdown posting identity`);
    }
    const contentHash = createHash('sha256').update(postingProjection(postings)).digest('hex');
    const neutral: SourceSnapshot = {
      sourceId: this.id,
      outcome: contentHash === previous?.contentHash ? 'unchanged' : 'changed',
      complete: true,
      postings,
      rawCount: rawListings.length + rejectedApplicationUrls.length,
      contentHash,
      checkpoint: {
        sourceId: this.id,
        etag: etag ?? previous?.etag,
        documentEtags,
        contentHash,
        lastSuccessAt: new Date().toISOString(),
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRowCount: 0,
        activeExternalIds: postings.map((posting) => posting.externalId),
      },
    };
    const processed = processSnapshot(neutral);
    neutral.checkpoint.lastRowCount = processed.listings.length;
    return {
      ...neutral,
      listings: processed.listings,
      ...(rejectedApplicationUrls.length ? { rejectedApplicationUrls } : {}),
      notModified: neutral.outcome === 'unchanged',
    };
  }
}

export const defaultSources: SourceAdapter[] = [
  new GitHubMarkdownAdapter({ id: 'vanshb03-summer-2027', owner: 'vanshb03', repo: 'Summer2027-Internships', documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2027' }, { path: 'OFFSEASON_README.md', branch: 'dev', season: 'offseason-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'simplify-summer-2026', owner: 'SimplifyJobs', repo: 'Summer2026-Internships', documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2026' }, { path: 'README-Off-Season.md', branch: 'dev', season: 'offseason-2026' }] }),
  new GitHubMarkdownAdapter({ id: 'zapply-2027', owner: 'zapplyjobs', repo: 'Internships-2027', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'speedyapply-2027-swe', owner: 'speedyapply', repo: '2027-SWE-College-Jobs', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }, { path: 'INTERN_INTL.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'speedyapply-2027-ai', owner: 'speedyapply', repo: '2027-AI-College-Jobs', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }, { path: 'INTERN_INTL.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'northwestern-fintech-2027-quant', owner: 'northwesternfintech', repo: '2027QuantInternships', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }], parser: parseQuantInternshipMarkdown }),
  new GitHubMarkdownAdapter({ id: 'canadian-tech-2027', owner: 'negarprh', repo: 'Canadian-Tech-Internships-2026', documents: [{ path: 'README-2027.md', branch: 'main', season: 'summer-2027' }] })
];
