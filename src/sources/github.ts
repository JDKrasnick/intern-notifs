import { createHash } from 'node:crypto';
import { parseInternshipMarkdown } from '../core/markdown.js';
import type { SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../types.js';

export interface GitHubDocument { path: string; branch: string; season: string; }
export interface GitHubAdapterOptions { id: string; owner: string; repo: string; documents: GitHubDocument[]; fetchImpl?: typeof fetch; }

export class GitHubMarkdownAdapter implements SourceAdapter {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: GitHubAdapterOptions) { this.id = options.id; this.fetchImpl = options.fetchImpl ?? fetch; }

  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    const listings = []; const documentEtags = { ...previous?.documentEtags }; let etag: string | undefined; let allUnchanged = true;
    for (const document of this.options.documents) {
      const url = `https://raw.githubusercontent.com/${this.options.owner}/${this.options.repo}/${document.branch}/${document.path}`;
      const knownEtag = previous?.documentEtags?.[document.path] ?? previous?.etag;
      const response = await this.fetchImpl(url, { headers: knownEtag ? { 'If-None-Match': knownEtag } : {} });
      if (response.status === 304) continue;
      if (!response.ok) throw new Error(`${this.id}: ${document.path} fetch failed (${response.status})`);
      allUnchanged = false; etag = response.headers.get('etag') ?? etag;
      const documentEtag = response.headers.get('etag'); if (documentEtag) documentEtags[document.path] = documentEtag;
      listings.push(...parseInternshipMarkdown(await response.text(), { sourceId: this.id, document: document.path, sourceUrl: url, season: document.season }));
    }
    const contentHash = createHash('sha256').update(JSON.stringify(listings)).digest('hex');
    return { sourceId: this.id, listings, notModified: allUnchanged, checkpoint: { sourceId: this.id, etag: etag ?? previous?.etag, documentEtags, contentHash, lastSuccessAt: new Date().toISOString(), successfulFetches: (previous?.successfulFetches ?? 0) + (allUnchanged ? 0 : 1), lastRowCount: allUnchanged ? previous?.lastRowCount : listings.length } };
  }
}

export const defaultSources: SourceAdapter[] = [
  new GitHubMarkdownAdapter({ id: 'vanshb03-summer-2027', owner: 'vanshb03', repo: 'Summer2027-Internships', documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2027' }, { path: 'OFFSEASON_README.md', branch: 'dev', season: 'offseason-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'simplify-summer-2026', owner: 'SimplifyJobs', repo: 'Summer2026-Internships', documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2026' }, { path: 'README-Off-Season.md', branch: 'dev', season: 'offseason-2026' }] }),
  new GitHubMarkdownAdapter({ id: 'zapply-2027', owner: 'zapplyjobs', repo: 'Internships-2027', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'speedyapply-2027-swe', owner: 'speedyapply', repo: '2027-SWE-College-Jobs', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'northwestern-fintech-2027-quant', owner: 'northwesternfintech', repo: '2027QuantInternships', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'canadian-tech-2027', owner: 'negarprh', repo: 'Canadian-Tech-Internships-2026', documents: [{ path: 'README-2027.md', branch: 'main', season: 'summer-2027' }] })
];
