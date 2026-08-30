import { applicationUrlRejection } from '../sources/quality.js';
import { createHash } from 'node:crypto';
import { platformFetch } from './platform-fetch.js';

const requestHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent': 'InternNotifs link verifier/1.0',
};

export class ApplicationUrlValidationError extends Error {}

export interface ApplicationUrlValidation { url: string; evidence: ApplicationPageEvidence; }
export type ApplicationUrlValidator = (url: string) => Promise<string | ApplicationUrlValidation>;

/**
 * Rewrites known employer URL aliases to the public route that actually
 * renders a job. TikTok serves a generic 200 shell at `/position/<id>`;
 * its canonical public posting route is `/search/<id>`.
 */
export function canonicalApplicationUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const match = url.hostname.toLowerCase() === 'lifeattiktok.com'
      ? /^\/position\/(\d+)\/?$/.exec(url.pathname)
      : undefined;
    return match ? `https://lifeattiktok.com/search/${match[1]}` : value;
  } catch {
    // Validation remains responsible for reporting malformed URLs.
    return value;
  }
}

/** Minimal server-rendered evidence available for any employer application page. */
export type ApplicationPageConfidenceLevel = 'high' | 'medium' | 'low';

export interface ApplicationPageConfidence {
  score: number;
  level: ApplicationPageConfidenceLevel;
  /** High-confidence roles may alert; uncertain roles remain catalog/review candidates. */
  recommendation: 'alert-eligible' | 'catalog-only' | 'review';
  signals: string[];
}

export interface ApplicationPageEvidence {
  url: string;
  /** A specific source path collapsed to a site's root after redirecting. */
  redirectedToGenericDestination?: boolean;
  title?: string;
  description?: string;
  expectedPostingId?: string;
  postingIdPresent?: boolean;
  jobPostingCount?: number;
  distinctJobLinkCount?: number;
  applicationFormPresent?: boolean;
  /** Browser frame that supplied the selected rendered posting proof. */
  evidenceFrameUrl?: string;
  evidenceFrameKind?: 'main' | 'child';
  renderedFrameCount?: number;
  failedFrameCount?: number;
  selfReferentialFrame?: boolean;
  /** Hash of bounded rendered frame evidence, excluding applicant-entered values. */
  renderedEvidenceHash?: string;
  /** Another expected posting ID produced the same normalized rendered artifact. */
  identicalEvidenceForDifferentPosting?: boolean;
  /** Bounded public job text, never applicant-entered data. */
  contentExcerpt?: string;
  contentHash?: string;
  contentSource?: 'json-ld' | 'main' | 'body';
  confidence: ApplicationPageConfidence;
}

export type SourceRoleAgreement = 'strong' | 'partial' | 'weak';

function genericCareerTitle(title: string | undefined): boolean {
  if (!title) return false;
  const value = title.replace(/\s+/g, ' ').trim();
  const hasSpecificRole = /\b(?:intern(?:ship)?|engineer|developer|scientist|analyst|designer|manager|researcher|associate|consultant|apprentice|co-?op)\b/i.test(value);
  if (hasSpecificRole) return false;
  return /\b(?:candidate experience|career section|job opportunities|open roles?|jobs? (?:and employment )?at|careers? at|join (?:our )?team|careers?)\b/i.test(value)
    || value.split(/\s+/).length <= 3;
}

function normalizedRoleText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/co[-\s]?op/g, ' coop ')
    .replace(/internships?/g, ' intern ')
    .replace(/engineerings?/g, ' engineer ')
    .replace(/developers?|development/g, ' develop ')
    .replace(/analysts?/g, ' analyst ')
    .replace(/scientists?/g, ' scientist ')
    .replace(/researchers?/g, ' researcher ')
    .replace(/designers?/g, ' design ')
    .replace(/[^a-z0-9+#.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function roleTerms(value: string): string[] {
  const ignored = new Set(['intern', 'coop', 'summer', 'fall', 'winter', 'spring', 'the', 'and', 'for', 'with', 'at', 'of', 'to', 'in', 'new', 'grad', 'university', 'college', 'software', 'technical', 'technology', 'technologies']);
  return [...new Set(normalizedRoleText(value).split(' ').filter((term) => term.length > 1 && !ignored.has(term) && !/^202\d$/.test(term)))];
}

/** Compares a source role with public title, metadata, and extracted job text. */
export function sourceRoleAgreement(role: string, evidence: ApplicationPageEvidence): SourceRoleAgreement {
  const source = normalizedRoleText(role);
  const page = normalizedRoleText([evidence.title, evidence.description, evidence.contentExcerpt].filter(Boolean).join(' '));
  if (!page) return 'weak';
  const sourcePhrase = source.split(' ').filter((term) => !['intern', 'coop', 'summer', 'fall', 'winter', 'spring'].includes(term)).join(' ');
  if (sourcePhrase.split(' ').length >= 2 && page.includes(sourcePhrase)) return 'strong';
  const terms = roleTerms(role);
  if (!terms.length) return 'partial';
  const found = terms.filter((term) => page.split(' ').includes(term)).length;
  const ratio = found / terms.length;
  return ratio >= 0.75 ? 'strong' : ratio >= 0.4 ? 'partial' : 'weak';
}

/**
 * Applies source-row context to transient scrape evidence. The caller must not
 * persist this result or `contentExcerpt`; it is only an alerting decision for
 * the current polling run.
 */
export function assessApplicationPageForListing(role: string, evidence: ApplicationPageEvidence): ApplicationPageConfidence {
  const base = evidence.confidence;
  const signals = [...base.signals];
  const agreement = sourceRoleAgreement(role, evidence);
  const substantiveJobContent = Boolean(evidence.contentExcerpt && evidence.contentExcerpt.length >= 300 && base.signals.includes('job-description language'));
  let score = base.score;
  if (agreement === 'strong' && substantiveJobContent) {
    score = Math.max(score, 75);
    signals.push('source role matches public job content');
  }
  if (evidence.redirectedToGenericDestination) {
    score = Math.min(score, 65);
    signals.push('specific posting redirected to generic destination');
  } else if (genericCareerTitle(evidence.title) && agreement !== 'strong') {
    score = Math.min(score, 65);
    signals.push('generic career-page title lacks source-role match');
  }
  const level: ApplicationPageConfidenceLevel = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
  return { score, level, recommendation: level === 'high' ? 'alert-eligible' : level === 'medium' ? 'catalog-only' : 'review', signals };
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|#38);/gi, '&').replace(/&(?:quot|#34);/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&(?:nbsp|#160);/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function textFromHtml(value: string): string {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function structuredJobText(html: string): { text?: string; source?: 'json-ld' } {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const values = Array.isArray(JSON.parse(match[1])) ? JSON.parse(match[1]) : [JSON.parse(match[1])];
      const queue = [...values];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) { queue.push(...value); continue; }
        const record = value as Record<string, unknown>;
        if (record['@graph']) queue.push(record['@graph']);
        const type = record['@type'];
        if ((Array.isArray(type) ? type : [type]).includes('JobPosting') && typeof record.description === 'string') {
          return { text: textFromHtml(record.description), source: 'json-ld' };
        }
      }
    } catch { /* A malformed publisher JSON-LD block is non-fatal. */ }
  }
  return {};
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch {
    // Cleanup is best-effort and must not replace the validation outcome.
  }
}

async function boundedResponseText(response: Response, maximumBytes = 512 * 1024): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await discardResponseBody(response);
    throw new ApplicationUrlValidationError('Application page exceeds the inspection size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maximumBytes) throw new ApplicationUrlValidationError('Application page exceeds the inspection size limit');
      chunks.push(value);
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the read or validation error that caused cancellation.
      }
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function applicationContent(html: string): { excerpt?: string; hash?: string; source?: 'json-ld' | 'main' | 'body' } {
  const structured = structuredJobText(html);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  const text = structured.text ?? (main ? textFromHtml(main) : textFromHtml(/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html));
  if (!text) return {};
  return { excerpt: text.slice(0, 12_000), hash: createHash('sha256').update(text).digest('hex'), source: structured.source ?? (main ? 'main' : 'body') };
}

const JOB_ROUTE = /(?:^|\/)(?:careers?|jobs?|openings?|positions?|roles?|vacancies?)(?:\/|$)/iu;

function distinctJobLinkCount(html: string, pageUrl: URL): number {
  const page = new URL(pageUrl);
  page.hash = '';
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/giu)) {
    try {
      const candidate = new URL(decodeHtml(match[1]!), page);
      candidate.hash = '';
      if (!['http:', 'https:'].includes(candidate.protocol) || candidate.toString() === page.toString()) continue;
      if (JOB_ROUTE.test(candidate.pathname)) links.add(candidate.toString());
    } catch { /* Malformed link evidence is ignored. */ }
  }
  return links.size;
}

function postingId(url: URL): string | undefined {
  // Long numeric IDs are common across ATSes. This remains optional evidence:
  // a valid posting may use a slug or load its structured data client-side.
  return [...url.pathname.matchAll(/\/(\d{6,})(?:\/|$)/g)].at(-1)?.[1];
}

function explicitErrorDestination(url: URL): boolean {
  const pathLooksLikeError = /(?:^|\/)(?:404|not[-_]?found|error(?:page)?)(?:\/|$)/i.test(url.pathname);
  const errorCode = [...url.searchParams.entries()].some(([key, value]) => /(?:error|status|code)/i.test(key) && /(?:404|not[-_]?found)/i.test(value));
  return pathLooksLikeError && errorCode;
}

function postingRedirectedToGenericDestination(source: URL, destination: URL): boolean {
  return source.hostname === destination.hostname
    && source.pathname !== '/'
    && destination.pathname === '/';
}

function confidenceFor(input: { html: boolean; title?: string; description?: string; contentExcerpt?: string; expectedPostingId?: string; postingIdPresent?: boolean; accessRestricted?: boolean; temporarilyUnavailable?: boolean }): ApplicationPageConfidence {
  let score = 25; const signals = ['destination reached'];
  if (input.accessRestricted) return { score, level: 'low', recommendation: 'review', signals: [...signals, 'access restricted to scraper'] };
  if (input.temporarilyUnavailable) return { score, level: 'low', recommendation: 'review', signals: [...signals, 'temporary server failure'] };
  if (!input.html) return { score, level: 'low', recommendation: 'review', signals: [...signals, 'non-HTML destination'] };
  score += 10; signals.push('HTML response');
  const hasRoleSignal = Boolean(input.title && /\b(?:intern(?:ship)?|job|position|role|engineer|developer|scientist|analyst|manager|designer|researcher|associate|consultant|apprentice|co-?op)\b/i.test(input.title));
  if (input.title) { score += 20; signals.push('page title'); }
  if (hasRoleSignal) { score += 10; signals.push('role-like title'); }
  if (input.description) { score += 15; signals.push('page description'); }
  if (input.contentExcerpt && input.contentExcerpt.length >= 300) {
    score += 10; signals.push('substantive page content');
    if (/\b(?:responsibilities|qualifications|requirements|what you(?:'|’)ll do|about the role|apply|intern(?:ship)?)\b/i.test(input.contentExcerpt)) {
      score += 5; signals.push('job-description language');
    }
  }
  if (input.expectedPostingId) {
    if (input.postingIdPresent) { score += 20; signals.push('posting ID appears in page'); }
    else signals.push('posting ID absent from server HTML');
  } else if (input.title) {
    score += 5; signals.push('slug-based or opaque URL');
  }
  if (genericCareerTitle(input.title)) {
    score = Math.min(score, 65); signals.push('generic career-page title');
  }
  const normalized = Math.min(score, 100);
  const level = normalized >= 70 ? 'high' : normalized >= 45 ? 'medium' : 'low';
  return { score: normalized, level, recommendation: level === 'high' ? 'alert-eligible' : level === 'medium' ? 'catalog-only' : 'review', signals };
}

/**
 * Reads a compact, server-rendered evidence layer for any application page.
 * Status codes alone are insufficient because many career sites return a 200
 * shell for expired or malformed role URLs.
 */
export async function inspectApplicationPage(
  value: string | URL,
  fetcher: typeof fetch = platformFetch,
): Promise<ApplicationPageEvidence> {
  const url = typeof value === 'string' ? new URL(value) : value;
  const expectedPostingId = postingId(url);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'follow',
      headers: requestHeaders,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApplicationUrlValidationError('Application page could not be reached');
  }
  const destination = new URL(response.url || url.toString());
  if (!response.ok) {
    await discardResponseBody(response);
    if ([401, 403, 429].includes(response.status) || response.status >= 500) {
      return {
        url: destination.toString(),
        ...(expectedPostingId ? { expectedPostingId } : {}),
        confidence: confidenceFor({ html: false, ...([401, 403, 429].includes(response.status) ? { accessRestricted: true } : { temporarilyUnavailable: true }), ...(expectedPostingId ? { expectedPostingId } : {}) }),
      };
    }
    throw new ApplicationUrlValidationError(`Application page returned HTTP ${response.status}`);
  }
  if (explicitErrorDestination(destination)) {
    await discardResponseBody(response);
    throw new ApplicationUrlValidationError('Application page redirected to an explicit error destination');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('html')) {
    await discardResponseBody(response);
    return {
      url: destination.toString(),
      ...(expectedPostingId ? { expectedPostingId } : {}),
      confidence: confidenceFor({ html: false, ...(expectedPostingId ? { expectedPostingId } : {}) }),
    };
  }
  const html = await boundedResponseText(response);
  const content = applicationContent(html);
  const title = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim();
  const description = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim();
  const postingIdPresent = expectedPostingId ? html.includes(expectedPostingId) : undefined;
  const jobPostingCount = [...html.matchAll(/["']@type["']\s*:\s*["']JobPosting["']/gi)].length;
  const jobLinkCount = distinctJobLinkCount(html, destination);
  const applicationFormPresent = /<form\b[^>]*(?:action=["'][^"']*(?:apply|application)|id=["'][^"']*(?:apply|application))|<input\b[^>]*(?:type=["']file["']|name=["'](?:resume|cv)["'])/i.test(html);
  if (title && /^(?:404 |page )?not found$|^(?:access denied|application error|error)$/i.test(title)) {
    throw new ApplicationUrlValidationError(`Application page reports ${title}`);
  }
  return {
    url: destination.toString(),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(expectedPostingId ? { expectedPostingId } : {}),
    ...(postingIdPresent !== undefined ? { postingIdPresent } : {}),
    ...(jobPostingCount ? { jobPostingCount } : {}),
    ...(jobLinkCount ? { distinctJobLinkCount: jobLinkCount } : {}),
    ...(applicationFormPresent ? { applicationFormPresent: true } : {}),
    ...(content.excerpt ? { contentExcerpt: content.excerpt, contentHash: content.hash, contentSource: content.source } : {}),
    confidence: confidenceFor({ html: true, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(content.excerpt ? { contentExcerpt: content.excerpt } : {}), ...(expectedPostingId ? { expectedPostingId } : {}), ...(postingIdPresent !== undefined ? { postingIdPresent } : {}) }),
  };
}

/** Optional source-specific host contract enforced in addition to the generic checks. */
export interface ApplicationUrlPolicy {
  /** Hosts the reported application URL may start on before any redirect. */
  allowedInitialHosts?: string[];
  /** Hosts the application URL may finally resolve to after redirects. */
  allowedFinalHosts?: string[];
}

/** Exact host or dot-boundary subdomain match; `greenhouse.io.evil.test` never matches `greenhouse.io`. */
function hostAllowed(host: string, allowedHosts: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowedHosts.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    return normalized === candidate || normalized.endsWith(`.${candidate}`);
  });
}

function httpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ApplicationUrlValidationError(`${label} is not a URL`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new ApplicationUrlValidationError(`${label} must be an HTTPS URL`);
  }
  return parsed;
}

/**
 * Confirms an official application URL resolves before it reaches the catalog
 * or an alert. The GET fallback covers career sites that reject or do not
 * implement HEAD requests.
 */
export async function validateApplicationUrlWithEvidence(
  value: string,
  fetcher: typeof fetch = platformFetch,
  policy?: ApplicationUrlPolicy,
): Promise<ApplicationUrlValidation> {
  const sourceUrl = httpsUrl(canonicalApplicationUrl(value), 'Application link');
  // Aggregators are never official application destinations, even for legacy
  // callers without a source-specific host contract.
  const rejection = applicationUrlRejection(value);
  if (rejection) throw new ApplicationUrlValidationError(rejection);
  // A source policy adds the initial-host contract; generic callers remain
  // backward compatible with respect to ordinary employer hosts.
  if (policy) {
    if (policy.allowedInitialHosts && !hostAllowed(sourceUrl.hostname, policy.allowedInitialHosts)) {
      throw new ApplicationUrlValidationError(`Application link host ${sourceUrl.hostname} is not an approved source host`);
    }
  }
  const request = async (method: 'HEAD' | 'GET') =>
    fetcher(sourceUrl, {
      method,
      redirect: 'follow',
      headers: method === 'GET' ? { ...requestHeaders, Range: 'bytes=0-0' } : requestHeaders,
      signal: AbortSignal.timeout(8_000),
    });

  let response: Response;
  try {
    response = await request('HEAD');
    if (!response.ok) {
      await discardResponseBody(response);
      response = await request('GET');
    }
  } catch (error) {
    const detail = error instanceof Error && error.name === 'TimeoutError'
      ? 'timed out'
      : 'could not be reached';
    throw new ApplicationUrlValidationError(`Application link ${detail}`);
  }

  if (!response.ok) {
    await discardResponseBody(response);
    if ([401, 403, 429].includes(response.status) || response.status >= 500) {
      const restricted = httpsUrl(response.url || sourceUrl.toString(), 'Resolved application link');
      if (policy?.allowedFinalHosts && !hostAllowed(restricted.hostname, policy.allowedFinalHosts)) {
        throw new ApplicationUrlValidationError(`Resolved application link host ${restricted.hostname} is not an approved destination host`);
      }
      return { url: restricted.toString(), evidence: { url: restricted.toString(), confidence: confidenceFor({ html: false, ...([401, 403, 429].includes(response.status) ? { accessRestricted: true } : { temporarilyUnavailable: true }) }) } };
    }
    throw new ApplicationUrlValidationError(`Application link returned HTTP ${response.status}`);
  }

  const resolved = httpsUrl(response.url || sourceUrl.toString(), 'Resolved application link');
  await discardResponseBody(response);
  if (policy?.allowedFinalHosts && !hostAllowed(resolved.hostname, policy.allowedFinalHosts)) {
    throw new ApplicationUrlValidationError(`Resolved application link host ${resolved.hostname} is not an approved destination host`);
  }
  const evidence = await inspectApplicationPage(resolved, fetcher);
  if (postingRedirectedToGenericDestination(sourceUrl, resolved)) {
    return { url: resolved.toString(), evidence: { ...evidence, redirectedToGenericDestination: true } };
  }
  return { url: resolved.toString(), evidence };
}

export async function validateApplicationUrl(value: string, fetcher: typeof fetch = platformFetch, policy?: ApplicationUrlPolicy): Promise<string> {
  return (await validateApplicationUrlWithEvidence(value, fetcher, policy)).url;
}

/** Binds a source policy (and optional fetcher) into the single-argument validator shape. */
export function createSourceUrlValidator(policy: ApplicationUrlPolicy, fetcher: typeof fetch = platformFetch): ApplicationUrlValidator {
  return (url: string) => validateApplicationUrlWithEvidence(url, fetcher, policy);
}
