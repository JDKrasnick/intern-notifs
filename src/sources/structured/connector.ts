import { createHash } from 'node:crypto';
import {
  applicationUrlMatchesContracts,
  assertPublicHttpsUrl,
  safeFetchText,
  type ApplicationHostContract,
  type HostResolver,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '../../employer/safe-network.js';
import { canonicalizePostingUrl } from '../../identity/posting.js';
import { processSnapshot } from '../../ingestion/processor.js';
import type { SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../../types.js';

export type StructuredSourceKind = 'json-ld' | 'job-sitemap' | 'embedded-json';

export interface StructuredSourceConfig {
  id: string;
  kind: StructuredSourceKind;
  url: string;
  employer: { id?: string; name: string };
  allowedApplicationHosts: readonly ApplicationHostContract[];
  /** Exact script identity and path are required; embedded payload discovery is intentionally unsupported. */
  embedded?: { scriptId: string; jobsPath: readonly string[] };
  limits?: { maxDocuments?: number; maxPostings?: number; maxBodyBytes?: number; timeoutMs?: number; maxRedirects?: number };
}

export interface StructuredConnectorOptions {
  source: StructuredSourceConfig;
  resolver: HostResolver;
  fetcher?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_MAX_DOCUMENTS = 50;
const DEFAULT_MAX_POSTINGS = 100;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const MAX_CONFIGURED_DOCUMENTS = 200;
const MAX_CONFIGURED_POSTINGS = 500;
const MAX_CONFIGURED_BODY_BYTES = 2 * 1024 * 1024;
const HTML_FORMAT = /<[^>]+>/;
const CHALLENGE_MARKERS = [
  /captcha/i, /cf-chl-/i, /cloudflare ray id/i, /verify (?:that )?you are human/i,
  /enable javascript and cookies/i, /access denied/i, /sign[ -]?in (?:to|required)/i, /log[ -]?in (?:to|required)/i,
];

interface NormalizedJob {
  id: string;
  title: string;
  description?: string;
  locations: string[];
  applyUrl: string;
  hostedUrl?: string;
  publishedAt?: string;
  employmentType?: string[];
  workMode?: string;
  compensation?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(stringValues);
}

function stableCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, stableCanonical(child)]));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableCanonical(value))).digest('hex');
}

function exactHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error();
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    throw new Error('Structured source URL must use plain HTTPS authority');
  }
}

function validInstant(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error('Posting datePublished must be an ISO timestamp');
  return new Date(timestamp).toISOString();
}

function locationName(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(locationName);
  if (!object(value)) return [];
  const direct = nonEmpty(value.name);
  const address = object(value.address) ? value.address : undefined;
  const parts = address
    ? [address.addressLocality, address.addressRegion, address.addressCountry].map(nonEmpty).filter((item): item is string => Boolean(item))
    : [];
  return direct ? [direct] : parts.length ? [parts.join(', ')] : [];
}

function jsonLdIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || undefined;
  if (!object(value)) return undefined;
  const property = nonEmpty(value.propertyID);
  const idValue = typeof value.value === 'string' || typeof value.value === 'number' ? String(value.value).trim() : '';
  if (!idValue) return undefined;
  return property ? `${property}:${idValue}` : idValue;
}

function jsonLdCompensation(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  const currency = nonEmpty(value.currency);
  const raw = object(value.value) ? value.value : undefined;
  if (!raw) return undefined;
  const amount = typeof raw.value === 'number' ? String(raw.value)
    : typeof raw.minValue === 'number' && typeof raw.maxValue === 'number' ? `${raw.minValue}-${raw.maxValue}` : undefined;
  const unit = nonEmpty(raw.unitText);
  return [currency, amount, unit ? `per ${unit}` : undefined].filter(Boolean).join(' ') || undefined;
}

function normalizeJsonLdJob(row: Record<string, unknown>): NormalizedJob {
  const id = jsonLdIdentifier(row.identifier);
  const title = nonEmpty(row.title);
  const applyUrl = nonEmpty(row.url);
  if (!id || !title || !applyUrl) throw new Error('JobPosting requires stable identifier, title, and URL');
  const remote = nonEmpty(row.jobLocationType);
  const locations = [...new Set([
    ...locationName(row.jobLocation),
    ...(remote?.toUpperCase() === 'TELECOMMUTE' ? ['Remote'] : []),
  ])];
  return {
    id, title, applyUrl, locations,
    description: nonEmpty(row.description), hostedUrl: applyUrl,
    publishedAt: validInstant(nonEmpty(row.datePublished)),
    employmentType: stringValues(row.employmentType),
    workMode: remote,
    compensation: jsonLdCompensation(row.baseSalary),
  };
}

function typeNames(value: unknown): string[] {
  return stringValues(value).map((item) => item.toLowerCase());
}

function collectJsonLdJobs(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((child) => collectJsonLdJobs(child, output));
    return;
  }
  if (!object(value)) return;
  if (typeNames(value['@type']).includes('jobposting')) output.push(value);
  if (Array.isArray(value['@graph'])) value['@graph'].forEach((child) => collectJsonLdJobs(child, output));
}

function scriptBodies(html: string, type: string, id?: string): string[] {
  const scripts: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = match[1] ?? '';
    const typeMatch = /\btype\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    const idMatch = /\bid\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    if (typeMatch?.[2]?.toLowerCase() === type.toLowerCase() && (id === undefined || idMatch?.[2] === id)) scripts.push(match[2] ?? '');
  }
  return scripts;
}

function parseJsonLdDocument(html: string): NormalizedJob[] {
  const bodies = scriptBodies(html, 'application/ld+json');
  if (!bodies.length) throw new Error('Document has no JobPosting JSON-LD scripts');
  const rows: Record<string, unknown>[] = [];
  for (const body of bodies) {
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new Error('Document contains malformed JSON-LD'); }
    collectJsonLdJobs(payload, rows);
  }
  return rows.map(normalizeJsonLdJob);
}

function embeddedValue(payload: unknown, path: readonly string[]): unknown {
  let value = payload;
  for (const segment of path) {
    if (!object(value) || !(segment in value)) throw new Error('Embedded jobs path is missing');
    value = value[segment];
  }
  return value;
}

function normalizeEmbeddedJob(value: unknown): NormalizedJob {
  if (!object(value)) throw new Error('Embedded posting row must be an object');
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id).trim() : '';
  const title = nonEmpty(value.title);
  const applyUrl = nonEmpty(value.applyUrl);
  if (!id || !title || !applyUrl) throw new Error('Embedded posting requires stable id, title, and applyUrl');
  const locations = stringValues(value.locations);
  return {
    id, title, applyUrl, locations,
    description: nonEmpty(value.description), hostedUrl: nonEmpty(value.hostedUrl),
    publishedAt: validInstant(nonEmpty(value.publishedAt)), employmentType: stringValues(value.employmentType),
    workMode: nonEmpty(value.workMode), compensation: nonEmpty(value.compensation),
  };
}

function parseEmbeddedDocument(html: string, config: NonNullable<StructuredSourceConfig['embedded']>): NormalizedJob[] {
  const bodies = scriptBodies(html, 'application/json', config.scriptId);
  if (bodies.length !== 1) throw new Error('Embedded source must have exactly one configured JSON script');
  let payload: unknown;
  try { payload = JSON.parse(bodies[0]!); } catch { throw new Error('Embedded source contains malformed JSON'); }
  const jobs = embeddedValue(payload, config.jobsPath);
  if (!Array.isArray(jobs)) throw new Error('Embedded jobs path must resolve to an array');
  return jobs.map(normalizeEmbeddedJob);
}

function xmlText(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function parseSitemap(xml: string): string[] {
  if (!/<urlset\b/i.test(xml) || /<sitemapindex\b/i.test(xml)) throw new Error('Only bounded URL-set job sitemaps are supported');
  const urls = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)].map((match) => xmlText(match[1] ?? ''));
  if (new Set(urls).size !== urls.length) throw new Error('Job sitemap contains duplicate URLs');
  return urls;
}

function assertResponse(response: SafeFetchResult, expectedHost: string, purpose: string): void {
  if (response.status === 401 || response.status === 403 || response.status === 407) throw new Error(`${purpose} is login- or challenge-gated`);
  if (response.status < 200 || response.status >= 300) throw new Error(`${purpose} returned HTTP ${response.status}`);
  if (exactHost(response.url) !== expectedHost) throw new Error(`${purpose} changed its reviewed host`);
  if (CHALLENGE_MARKERS.some((pattern) => pattern.test(response.body.slice(0, 64 * 1024)))) throw new Error(`${purpose} appears login- or challenge-gated`);
}

function assertUniqueJobs(jobs: NormalizedJob[], maxPostings: number): void {
  if (jobs.length > maxPostings) throw new Error(`Structured source exceeds posting limit (${maxPostings})`);
  const identities = new Map<string, NormalizedJob>();
  const destinations = new Map<string, string>();
  for (const job of jobs) {
    if (identities.has(job.id)) throw new Error(`Structured source contains duplicate posting ID: ${job.id}`);
    identities.set(job.id, job);
    let canonical: string;
    try { canonical = canonicalizePostingUrl(job.applyUrl); } catch { throw new Error(`Posting ${job.id} has an invalid application URL`); }
    const prior = destinations.get(canonical);
    if (prior) throw new Error(`Structured source has ambiguous duplicate destination for ${prior} and ${job.id}`);
    destinations.set(canonical, job.id);
  }
}

function posting(job: NormalizedJob, config: StructuredSourceConfig, fetchedAt: string, row: number, document: string): SourcedPosting {
  if (!applicationUrlMatchesContracts(job.applyUrl, config.allowedApplicationHosts)) {
    throw new Error(`Posting ${job.id} application URL is outside reviewed host contracts`);
  }
  return {
    sourceId: config.id,
    provenance: 'official-structured',
    externalId: job.id,
    document,
    sourceUrl: config.url,
    row,
    fetchedAt,
    employer: { ...config.employer, authority: 'reviewed-registry' },
    title: job.title,
    content: job.description ? [{ kind: 'description', format: HTML_FORMAT.test(job.description) ? 'html' : 'plain', value: job.description }] : [],
    locations: job.locations,
    applyUrl: job.applyUrl,
    ...(job.hostedUrl ? { hostedUrl: job.hostedUrl } : {}),
    sourceState: 'open',
    ...(job.publishedAt ? { publishedAt: job.publishedAt, providerTimestamp: { value: job.publishedAt, semantics: 'published' as const } } : {}),
    ...(job.employmentType?.length ? { classificationTags: job.employmentType } : {}),
    ...(job.workMode ? { declaredWorkMode: job.workMode } : {}),
    ...(job.compensation ? { compensationText: job.compensation } : {}),
  };
}

export class StructuredCareerSourceConnector implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly now: () => Date;
  private readonly sourceHost: string;
  private readonly limits: Required<NonNullable<StructuredSourceConfig['limits']>>;
  private readonly fetchOptions: SafeFetchOptions;

  constructor(private readonly options: StructuredConnectorOptions) {
    this.id = options.source.id;
    this.now = options.now ?? (() => new Date());
    this.sourceHost = exactHost(options.source.url);
    if (!options.source.id.trim() || !options.source.employer.name.trim() || !options.source.allowedApplicationHosts.length) {
      throw new Error('Structured source requires identity, employer, and reviewed application hosts');
    }
    if (options.source.kind === 'embedded-json' && (!options.source.embedded?.scriptId || !options.source.embedded.jobsPath.length)) {
      throw new Error('Embedded source requires an exact script ID and non-empty jobs path');
    }
    if (options.source.kind !== 'embedded-json' && options.source.embedded) throw new Error('Embedded contract is only valid for embedded-json sources');
    const configured = options.source.limits ?? {};
    this.limits = {
      maxDocuments: configured.maxDocuments ?? DEFAULT_MAX_DOCUMENTS,
      maxPostings: configured.maxPostings ?? DEFAULT_MAX_POSTINGS,
      maxBodyBytes: configured.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      timeoutMs: configured.timeoutMs ?? 5_000,
      maxRedirects: configured.maxRedirects ?? 2,
    };
    if (!Object.values(this.limits).every((value) => Number.isSafeInteger(value))
      || this.limits.maxDocuments < 1 || this.limits.maxDocuments > MAX_CONFIGURED_DOCUMENTS
      || this.limits.maxPostings < 1 || this.limits.maxPostings > MAX_CONFIGURED_POSTINGS
      || this.limits.maxBodyBytes < 1 || this.limits.maxBodyBytes > MAX_CONFIGURED_BODY_BYTES
      || this.limits.timeoutMs < 1 || this.limits.maxRedirects < 0) throw new Error('Structured source limits are outside supported bounds');
    this.fetchOptions = {
      resolver: options.resolver, fetcher: options.fetcher, timeoutMs: this.limits.timeoutMs,
      maxRedirects: this.limits.maxRedirects, maxBodyBytes: this.limits.maxBodyBytes,
      headers: { Accept: 'text/html, application/ld+json, application/json, application/xml, text/xml' },
    };
  }

  private async document(url: string, purpose: string): Promise<SafeFetchResult> {
    const response = await safeFetchText(url, this.fetchOptions);
    assertResponse(response, this.sourceHost, purpose);
    return response;
  }

  async fetch(previous?: SourceCheckpoint): Promise<SourceSnapshot & SourceFetchResult> {
    const root = await this.document(this.options.source.url, 'Structured source');
    const documents: Array<{ url: string; jobs: NormalizedJob[] }> = [];
    if (this.options.source.kind === 'json-ld') {
      documents.push({ url: root.url, jobs: parseJsonLdDocument(root.body) });
    } else if (this.options.source.kind === 'embedded-json') {
      documents.push({ url: root.url, jobs: parseEmbeddedDocument(root.body, this.options.source.embedded!) });
    } else {
      const urls = parseSitemap(root.body);
      if (urls.length > this.limits.maxDocuments) throw new Error(`Job sitemap exceeds document limit (${this.limits.maxDocuments})`);
      for (const url of urls) {
        if (exactHost(url) !== this.sourceHost) throw new Error('Job sitemap URL changed its reviewed host');
      }
      const pages = await Promise.all(urls.map((url) => this.document(url, 'Job sitemap document')));
      pages.forEach((page) => documents.push({ url: page.url, jobs: parseJsonLdDocument(page.body) }));
    }
    const jobs = documents.flatMap(({ jobs }) => jobs);
    assertUniqueJobs(jobs, this.limits.maxPostings);
    await Promise.all(jobs.map(async (job) => {
      if (!applicationUrlMatchesContracts(job.applyUrl, this.options.source.allowedApplicationHosts)) {
        throw new Error(`Posting ${job.id} application URL is outside reviewed host contracts`);
      }
      await assertPublicHttpsUrl(job.applyUrl, this.options.resolver);
    }));
    const fetchedAt = this.now().toISOString();
    let row = 0;
    const postings = documents.flatMap(({ url, jobs: pageJobs }) => pageJobs.map((job) => posting(job, this.options.source, fetchedAt, ++row, url)));
    const contentHash = hash(postings.map(({ externalId, title, locations, applyUrl, hostedUrl, content, publishedAt, classificationTags, declaredWorkMode, compensationText }) => ({
      externalId, title, locations, applyUrl, hostedUrl, content, publishedAt, classificationTags, declaredWorkMode, compensationText,
    })).sort((a, b) => a.externalId.localeCompare(b.externalId)));
    const snapshot: SourceSnapshot = {
      sourceId: this.id,
      outcome: contentHash === previous?.contentHash ? 'unchanged' : 'changed',
      complete: true,
      postings,
      rawCount: jobs.length,
      contentHash,
      checkpoint: {
        sourceId: this.id,
        contentHash,
        lastSuccessAt: fetchedAt,
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRawCount: jobs.length,
        lastRowCount: postings.length,
        activeExternalIds: postings.map(({ externalId }) => externalId).sort(),
      },
    };
    const processed = processSnapshot(snapshot);
    const listings = processed.listings.filter((listing) => listing.technical !== false);
    snapshot.checkpoint.lastRowCount = listings.length;
    return {
      ...snapshot,
      rawRowCount: snapshot.rawCount,
      processed,
      listings,
      notModified: snapshot.outcome === 'unchanged',
      ...(snapshot.outcome === 'unchanged' ? { unchangedReason: 'content_hash' as const } : {}),
    };
  }
}
