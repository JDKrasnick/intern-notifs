/**
 * Lever candidate ledger.
 *
 * Lever's Postings API attributes nothing: a 200 proves a site exists, never who
 * owns it. So a candidate may only enter this ledger from a URL somebody already
 * observed. Deriving `site` from a company name is the failure mode this module
 * exists to prevent — `geocomply-2` and `wingtra-2` are not slugs of anything,
 * and a wrong guess returns a healthy board of somebody else's jobs.
 *
 * The ledger is an artifact. It publishes nothing, schedules nothing, and grants
 * no application-host allowance. See
 * `docs/lever-ownership-verification-plan.md`.
 */
export const LEVER_APPLICATION_HOST = 'jobs.lever.co';

const leverSitePattern = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const leverPostingPath = /^\/([^/]+)\/([^/]+)(?:\/apply)?\/?$/;
const leverBoardPath = /^\/([^/]+)\/?$/;

export interface LeverCandidateSighting {
  sourceId: string;
  /** Employer name the source row carried. A lead, never a display name. */
  company: string;
  applyUrl: string;
}

export interface LeverCandidate {
  site: string;
  observedCompany: string;
  /**
   * Every distinct employer name seen against this site. More than one is the
   * ledger's cheapest signal for `ambiguous-owner`.
   */
  observedCompanyVariants: string[];
  referencingSources: string[];
  eligibleListings: number;
  sampleJobUrl: string;
  firstSeenAt: string;
}

export function validateLeverSite(site: string): boolean {
  return leverSitePattern.test(site);
}

/**
 * The only sanctioned way to learn a site string: read it out of a URL that was
 * already observed pointing at a live posting.
 */
export function leverSiteFromApplicationUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== LEVER_APPLICATION_HOST) return undefined;
  const site = (leverPostingPath.exec(parsed.pathname) ?? leverBoardPath.exec(parsed.pathname))?.[1]?.toLowerCase();
  return site && validateLeverSite(site) ? site : undefined;
}

function isPostingUrl(url: string): boolean {
  try {
    return leverPostingPath.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface LeverLedgerOptions {
  /** Sites already in the reviewed registry, which need no candidate row. */
  registeredSites?: Iterable<string>;
  firstSeenAt?: string;
}

export function buildLeverCandidateLedger(
  sightings: readonly LeverCandidateSighting[],
  options: LeverLedgerOptions = {},
): LeverCandidate[] {
  const registered = new Set([...(options.registeredSites ?? [])].map((site) => site.toLowerCase()));
  const firstSeenAt = (options.firstSeenAt ?? new Date().toISOString()).slice(0, 10);
  interface SiteTally {
    eligibleListings: number;
    companies: Map<string, number>;
    sources: Set<string>;
    postingUrl?: string;
    boardUrl?: string;
  }
  const bySite = new Map<string, SiteTally>();

  for (const sighting of sightings) {
    const site = leverSiteFromApplicationUrl(sighting.applyUrl);
    if (!site || registered.has(site)) continue;
    const entry: SiteTally = bySite.get(site) ?? { eligibleListings: 0, companies: new Map(), sources: new Set() };
    entry.eligibleListings += 1;
    entry.sources.add(sighting.sourceId);
    const company = sighting.company.trim();
    if (company) entry.companies.set(company, (entry.companies.get(company) ?? 0) + 1);
    if (isPostingUrl(sighting.applyUrl)) entry.postingUrl ??= sighting.applyUrl;
    else entry.boardUrl ??= sighting.applyUrl;
    bySite.set(site, entry);
  }

  return [...bySite.entries()]
    .map(([site, entry]) => {
      const variants = [...entry.companies.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([company]) => company);
      return {
        site,
        observedCompany: variants[0] ?? '',
        observedCompanyVariants: variants,
        referencingSources: [...entry.sources].sort(),
        eligibleListings: entry.eligibleListings,
        sampleJobUrl: entry.postingUrl ?? entry.boardUrl ?? '',
        firstSeenAt,
      };
    })
    .sort((a, b) => b.eligibleListings - a.eligibleListings || a.site.localeCompare(b.site));
}
