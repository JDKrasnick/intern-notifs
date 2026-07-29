import { createHash } from 'node:crypto';
import { isTechnicalJob } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import { processSnapshot } from '../ingestion/processor.js';
import { SourceFetchError } from './source-error.js';
import type { JobRequirements, RawListing, SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../types.js';

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

export function mapLeverSourcedPosting(
  posting: LeverPosting,
  options: Pick<LeverAdapterOptions, 'id' | 'company' | 'site'>,
  fetchedAt = new Date().toISOString(),
  row = 1,
): SourcedPosting {
  if (!posting.id || !posting.text || !posting.applyUrl || !posting.hostedUrl) {
    throw new SourceFetchError(`${options.id}: Lever posting shape was invalid`, 'json');
  }
  const expectedHosted = new RegExp(`^/${options.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${posting.id}/?$`);
  const expectedApply = new RegExp(`^/${options.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${posting.id}/apply/?$`);
  let hosted: URL;
  let apply: URL;
  try {
    hosted = new URL(posting.hostedUrl);
    apply = new URL(posting.applyUrl);
  } catch {
    throw new SourceFetchError(`${options.id}: Lever posting URL contract was invalid`, 'identity');
  }
  if (hosted.protocol !== 'https:' || apply.protocol !== 'https:' || hosted.hostname !== 'jobs.lever.co'
    || apply.hostname !== 'jobs.lever.co' || !expectedHosted.test(hosted.pathname) || !expectedApply.test(apply.pathname)) {
    throw new SourceFetchError(`${options.id}: Lever posting URL contract was invalid`, 'identity');
  }
  const content = [
    posting.descriptionPlain,
    posting.description,
    posting.additionalPlain,
    posting.additional,
  ].filter((value): value is string => typeof value === 'string').map((value) => ({
    kind: 'description' as const,
    format: value.includes('<') ? 'html' as const : 'plain' as const,
    value,
  }));
  return {
    sourceId: options.id,
    externalId: posting.id,
    document: posting.id,
    sourceUrl: `https://api.lever.co/v0/postings/${options.site}?mode=json`,
    row,
    fetchedAt,
    employer: { name: options.company, authority: 'reviewed-registry' },
    title: posting.text,
    content,
    locations: posting.categories?.location
      ? [posting.categories.location]
      : posting.categories?.allLocations ?? [],
    applyUrl: posting.applyUrl,
    hostedUrl: posting.hostedUrl,
    sourceState: 'open',
    ...(postedAt(posting) ? { publishedAt: postedAt(posting) } : {}),
    classificationTags: [posting.categories?.commitment, posting.categories?.team].filter((value): value is string => Boolean(value)),
    declaredWorkMode: posting.workplaceType,
  };
}

function normalizedProjection(postings: LeverPosting[]): string {
  return JSON.stringify([...postings].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''))));
}

type TransitionalLeverResult = SourceSnapshot & SourceFetchResult;

export class LeverPostingsAdapter implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: LeverAdapterOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(previous?: SourceCheckpoint): Promise<TransitionalLeverResult> {
    const sourceUrl = `https://api.lever.co/v0/postings/${this.options.site}?mode=json`;
    const response = await this.fetchImpl(sourceUrl, {
      headers: { Accept: 'application/json', ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}) },
    });
    if (response.status === 304) {
      return {
        sourceId: this.id,
        outcome: 'unchanged',
        complete: true,
        postings: [],
        rawCount: previous?.lastRowCount ?? 0,
        contentHash: previous?.contentHash ?? '',
        listings: [],
        notModified: true,
        checkpoint: { ...previous, sourceId: this.id, lastSuccessAt: this.now().toISOString(), successfulFetches: previous?.successfulFetches ?? 0 },
      };
    }
    if (!response.ok) throw new SourceFetchError(`${this.id}: Lever fetch failed (${response.status})`, 'http', response.status);
    let postings: unknown;
    try { postings = await response.json(); } catch { throw new SourceFetchError(`${this.id}: Lever returned malformed JSON`, 'json'); }
    if (!Array.isArray(postings)) throw new SourceFetchError(`${this.id}: Lever response was not an array`, 'json');
    const fetchedAt = this.now().toISOString();
    const sourced = postings.map((posting, index) => mapLeverSourcedPosting(posting as LeverPosting, this.options, fetchedAt, index + 1));
    if (new Set(sourced.map((posting) => posting.externalId)).size !== sourced.length) {
      throw new SourceFetchError(`${this.id}: Lever returned duplicate posting IDs`, 'identity');
    }
    const contentHash = createHash('sha256').update(normalizedProjection(postings as LeverPosting[])).digest('hex');
    const neutral: SourceSnapshot = {
      sourceId: this.id,
      outcome: contentHash === previous?.contentHash ? 'unchanged' : 'changed',
      complete: true,
      postings: sourced,
      rawCount: postings.length,
      contentHash,
      checkpoint: {
        sourceId: this.id,
        etag: response.headers.get('etag') ?? previous?.etag,
        contentHash,
        lastSuccessAt: fetchedAt,
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRowCount: 0,
        activeExternalIds: sourced.map((posting) => posting.externalId),
      },
    };
    const processed = processSnapshot(neutral);
    neutral.checkpoint.lastRowCount = processed.listings.length;
    return {
      ...neutral,
      listings: processed.listings,
      notModified: neutral.outcome === 'unchanged',
    };
  }
}

export const approvedLeverSourceConfigs: LeverAdapterOptions[] = [
  { id: 'lever-palantir', company: 'Palantir Technologies', site: 'palantir' },
  { id: 'lever-plusai', company: 'PlusAI', site: 'plus-2' },
  { id: 'lever-hermeus', company: 'Hermeus', site: 'hermeus' },
  { id: 'lever-xsolla', company: 'Xsolla', site: 'xsolla' },
];

export const approvedLeverSources: SourceAdapter[] = approvedLeverSourceConfigs.map(
  (options) => new LeverPostingsAdapter(options),
);
