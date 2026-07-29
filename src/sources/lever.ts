import { createHash } from 'node:crypto';
import { isTechnicalJob } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import type { JobRequirements, RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../types.js';

export interface LeverPosting {
  id?: string;
  text?: string;
  applyUrl?: string;
  hostedUrl?: string;
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  createdAt?: number;
  updatedAt?: number;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  workplaceType?: string;
}

export interface LeverAdapterOptions {
  id: string;
  company: string;
  /** Lever's public site identifier, which is also enforced in the application URL. */
  site: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const rolePattern = /\b(?:intern(?:ship)?|co[ -]?op|cooperative education|apprentice(?:ship)?)\b/i;
const usCitizen = '(?:u\\.?s\\.?|united states)\\s+citizens?';
const degree = "(?:advanced degree|master'?s|ph\\.?d\\.?|doctorate|mba)";
const citizenshipPattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only|only)\\b[^.]{0,120}${usCitizen}|${usCitizen}[^.]{0,80}\\b(?:required|only|must)\\b)`, 'i');
const advancedDegreePattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only)\\b[^.]{0,120}${degree}|${degree}[^.]{0,80}\\b(?:required|must)\\b)`, 'i');

function plain(value: string | undefined) {
  return (value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

export function inferLeverSeason(title: string, description: string): string {
  const text = `${title} ${description}`;
  const season = text.match(/\b(summer|fall|spring|winter)\s*(?:intern(?:ship)?\s*)?(20\d{2})\b/i);
  if (season) return `${season[1].toLowerCase()}-${season[2]}`;
  const year = text.match(/\b(20\d{2})\b/);
  return year ? year[1] : 'ongoing';
}

export function leverRequirements(content: string): JobRequirements {
  return {
    requiresUsCitizenship: citizenshipPattern.test(content),
    advancedDegreeRequired: advancedDegreePattern.test(content)
  };
}

function workMode(value: string | undefined): RawListing['workMode'] | undefined {
  if (!value) return undefined;
  if (/remote/i.test(value)) return 'remote';
  if (/hybrid/i.test(value)) return 'hybrid';
  if (/on.?site|in.?person/i.test(value)) return 'onsite';
  return undefined;
}

function postedAt(posting: LeverPosting): string | undefined {
  const timestamp = posting.createdAt ?? posting.updatedAt;
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}

export function mapLeverPosting(posting: LeverPosting, options: Pick<LeverAdapterOptions, 'id' | 'company' | 'site'>, fetchedAt = new Date().toISOString(), row = 1): RawListing | undefined {
  const title = plain(posting.text);
  const content = [posting.descriptionPlain, posting.description, posting.additionalPlain, posting.additional].map(plain).join(' ');
  if (!title || !posting.applyUrl || !rolePattern.test(title)) return undefined;
  const season = inferLeverSeason(title, content);
  const location = plain(posting.categories?.location) || posting.categories?.allLocations?.map(plain).filter(Boolean).join(' / ') || 'Unspecified';
  const listing: RawListing = {
    sourceId: options.id,
    document: posting.id ?? posting.hostedUrl ?? posting.applyUrl,
    sourceUrl: `https://api.lever.co/v0/postings/${options.site}?mode=json`,
    row,
    company: options.company,
    title,
    location,
    season,
    applyUrl: posting.applyUrl,
    compensation: parseCompensation(content),
    requirements: leverRequirements(content),
    state: 'open',
    postedAt: postedAt(posting),
    workMode: workMode(posting.workplaceType),
    fetchedAt
  };
  return isTechnicalJob(listing) ? listing : undefined;
}

export class LeverPostingsAdapter implements SourceAdapter {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: LeverAdapterOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    const sourceUrl = `https://api.lever.co/v0/postings/${this.options.site}?mode=json`;
    const response = await this.fetchImpl(sourceUrl, { headers: previous?.etag ? { 'If-None-Match': previous.etag } : {} });
    if (response.status === 304) {
      return { sourceId: this.id, listings: [], notModified: true, checkpoint: { ...previous, sourceId: this.id, lastSuccessAt: this.now().toISOString(), successfulFetches: previous?.successfulFetches ?? 0 } };
    }
    if (!response.ok) throw new Error(`${this.id}: Lever fetch failed (${response.status})`);
    let postings: unknown;
    try { postings = await response.json(); } catch { throw new Error(`${this.id}: Lever returned malformed JSON`); }
    if (!Array.isArray(postings)) throw new Error(`${this.id}: Lever response was not an array`);
    const fetchedAt = this.now().toISOString();
    const listings = postings.map((posting, index) => mapLeverPosting(posting as LeverPosting, this.options, fetchedAt, index + 1)).filter((listing): listing is RawListing => Boolean(listing));
    return {
      sourceId: this.id,
      listings,
      notModified: false,
      checkpoint: {
        sourceId: this.id,
        etag: response.headers.get('etag') ?? previous?.etag,
        contentHash: createHash('sha256').update(JSON.stringify(postings)).digest('hex'),
        lastSuccessAt: fetchedAt,
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRowCount: listings.length
      }
    };
  }
}

export const approvedLeverSources: SourceAdapter[] = [
  new LeverPostingsAdapter({ id: 'lever-palantir', company: 'Palantir Technologies', site: 'palantir' }),
  new LeverPostingsAdapter({ id: 'lever-plusai', company: 'PlusAI', site: 'plus-2' }),
  new LeverPostingsAdapter({ id: 'lever-hermeus', company: 'Hermeus', site: 'hermeus' }),
  new LeverPostingsAdapter({ id: 'lever-xsolla', company: 'Xsolla', site: 'xsolla' })
];
