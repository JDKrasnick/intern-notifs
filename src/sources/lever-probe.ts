/**
 * Read-only Lever candidate probe, mirroring `probeGreenhouseCandidate`.
 *
 * The probe measures; it never attributes. Greenhouse's probe can return a board
 * name, so its result carries a weak identity signal. Lever's cannot, so this
 * result carries `attribution: 'unattributed'` as a literal: nothing downstream
 * can read an owner off a probe, because there is no field to read it from.
 *
 * It writes no registry entry and grants no host allowance.
 */
import { LEVER_MAX_PAGES, LEVER_PAGE_SIZE, mapLeverSourcedPosting, type LeverPosting } from './lever.js';
import { validateLeverSite } from './lever-ledger.js';
import { processSnapshot } from '../ingestion/processor.js';
import type { SourceSnapshot, SourcedPosting } from '../types.js';

export const LEVER_POSTINGS_API_HOST = 'api.lever.co';

/**
 * `employer.name` is a grouping key for truncated-title repair, so the mapper
 * needs one. Naming it after the site would look like an attribution, so it is
 * named after what the probe actually knows.
 */
const PROBE_EMPLOYER_PLACEHOLDER = 'unattributed-lever-candidate';

export type LeverCandidateProbeResult =
  | {
    state: 'ok';
    site: string;
    endpoint: string;
    /** Recorded, never inferred: the EU region is served from separate hosts. */
    region: 'global';
    attribution: 'unattributed';
    pagesRead: number;
    rawPostings: number;
    eligibleEarlyCareerRoles: number;
    malformedRows: number;
    urlContractViolations: number;
    applicationHostSummary: Record<string, number>;
    etagPresent: boolean;
    eligibleRoleSamples: Array<{ postingId: string; title: string }>;
  }
  | {
    state: 'invalid-site' | 'site-not-found' | 'http-error' | 'json-error' | 'response-host-error' | 'pagination-exceeded' | 'transport-error';
    site: string;
    endpoint: string;
    status?: number;
    inconclusive?: boolean;
  };

function postingsEndpoint(site: string): string {
  return `https://${LEVER_POSTINGS_API_HOST}/v0/postings/${site}?mode=json`;
}

function isLeverPostingShape(posting: unknown): posting is LeverPosting & { id: string; text: string; applyUrl: string; hostedUrl: string } {
  if (!posting || typeof posting !== 'object') return false;
  const candidate = posting as Record<string, unknown>;
  return ['id', 'text', 'applyUrl', 'hostedUrl'].every((field) => typeof candidate[field] === 'string' && candidate[field]);
}

/** The same contract `mapLeverSourcedPosting` enforces, counted instead of thrown. */
export function leverUrlContractViolation(
  posting: { id: string; hostedUrl: string; applyUrl: string },
  site: string,
): string | undefined {
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expected: Array<[string, string, RegExp]> = [
    ['hostedUrl', posting.hostedUrl, new RegExp(`^/${escaped}/${posting.id}/?$`)],
    ['applyUrl', posting.applyUrl, new RegExp(`^/${escaped}/${posting.id}/apply/?$`)],
  ];
  for (const [field, value, path] of expected) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return `${field} is not a URL`;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'jobs.lever.co') return `${field} is not on https://jobs.lever.co`;
    if (!path.test(parsed.pathname)) return `${field} does not match /${site}/${posting.id}`;
  }
  return undefined;
}

export async function probeLeverCandidate(
  site: string,
  fetchImpl: typeof fetch = fetch,
  fetchedAt = new Date().toISOString(),
): Promise<LeverCandidateProbeResult> {
  const endpoint = postingsEndpoint(site);
  if (!validateLeverSite(site)) return { state: 'invalid-site', site, endpoint };

  const postings: unknown[] = [];
  let etagPresent = false;
  let pagesRead = 0;
  // A large board must be measured whole, so the probe reads every page the
  // adapter would read rather than judging a board by its first page.
  for (let page = 0; page < LEVER_MAX_PAGES; page += 1) {
    const pageUrl = `${endpoint}&skip=${page * LEVER_PAGE_SIZE}&limit=${LEVER_PAGE_SIZE}`;
    let response: Response;
    try {
      response = await fetchImpl(pageUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch {
      return { state: 'transport-error', site, endpoint, inconclusive: true };
    }
    if (response.status === 404) return { state: 'site-not-found', site, endpoint, status: 404 };
    if (!response.ok) return { state: 'http-error', site, endpoint, status: response.status };
    try {
      if (new URL(response.url || pageUrl).hostname.toLowerCase() !== LEVER_POSTINGS_API_HOST) {
        return { state: 'response-host-error', site, endpoint };
      }
    } catch {
      return { state: 'response-host-error', site, endpoint };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { state: 'json-error', site, endpoint };
    }
    if (!Array.isArray(payload)) return { state: 'json-error', site, endpoint };
    pagesRead += 1;
    if (page === 0) etagPresent = Boolean(response.headers.get('etag'));
    postings.push(...payload);
    if (payload.length < LEVER_PAGE_SIZE) break;
    if (page === LEVER_MAX_PAGES - 1) return { state: 'pagination-exceeded', site, endpoint };
  }

  const applicationHostSummary: Record<string, number> = {};
  const mapped: SourcedPosting[] = [];
  let malformedRows = 0;
  let urlContractViolations = 0;
  for (const posting of postings) {
    if (!isLeverPostingShape(posting)) {
      malformedRows += 1;
      continue;
    }
    try {
      const host = new URL(posting.applyUrl).hostname.toLowerCase();
      applicationHostSummary[host] = (applicationHostSummary[host] ?? 0) + 1;
    } catch { /* Unparseable URLs are represented by their absence from the host summary. */ }
    if (leverUrlContractViolation(posting, site)) {
      urlContractViolations += 1;
      continue;
    }
    mapped.push(mapLeverSourcedPosting(
      posting,
      { id: `lever-candidate-${site}`, company: PROBE_EMPLOYER_PLACEHOLDER, site },
      fetchedAt,
      mapped.length + 1,
    ));
  }

  const snapshot: SourceSnapshot = {
    sourceId: `lever-candidate-${site}`,
    outcome: 'changed',
    complete: true,
    postings: mapped,
    rawCount: postings.length,
    contentHash: '',
    checkpoint: { sourceId: `lever-candidate-${site}`, lastSuccessAt: fetchedAt, successfulFetches: 0 },
  };
  const eligible = processSnapshot(snapshot).listings.filter((listing) => listing.technical !== false);

  return {
    state: 'ok',
    site,
    endpoint,
    region: 'global',
    attribution: 'unattributed',
    pagesRead,
    rawPostings: postings.length,
    eligibleEarlyCareerRoles: eligible.length,
    malformedRows,
    urlContractViolations,
    applicationHostSummary,
    etagPresent,
    eligibleRoleSamples: eligible.slice(0, 3).map((listing) => ({ postingId: listing.externalId ?? '', title: listing.title })),
  };
}
