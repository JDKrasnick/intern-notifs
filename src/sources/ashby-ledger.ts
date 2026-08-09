/** Read-only Ashby discovery ledger. Board keys only come from observed URLs. */
export const ASHBY_JOB_HOST = 'jobs.ashbyhq.com';

const boardPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export interface AshbyCandidateSighting {
  sourceId: string;
  company: string;
  applyUrl: string;
  location: string;
}

export type AshbyReviewState = 'pending-review' | 'ambiguous-owner';

export interface AshbyCandidate {
  boardName: string;
  observedCompany: string;
  observedCompanyVariants: string[];
  referencingSources: string[];
  roleCount: number;
  geographicCoverage: string[];
  sampleJobUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reviewState: AshbyReviewState;
}

export function validateAshbyBoardName(boardName: string): boolean {
  return boardPattern.test(boardName) && boardName !== '.' && boardName !== '..';
}

/** Extracts the exact first path segment; it never slugifies a company name. */
export function ashbyBoardNameFromUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== ASHBY_JOB_HOST || (url.port && url.port !== '443')) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 3) return undefined;
  let boardName: string;
  try { boardName = decodeURIComponent(segments[0]!); } catch { return undefined; }
  if (!validateAshbyBoardName(boardName)) return undefined;
  if (segments.length === 3 && segments[2] !== 'application') return undefined;
  return boardName;
}

export interface AshbyLedgerOptions {
  registeredBoards?: Iterable<string>;
  observedAt?: string;
}

export function buildAshbyCandidateLedger(
  sightings: readonly AshbyCandidateSighting[],
  options: AshbyLedgerOptions = {},
): AshbyCandidate[] {
  // Discovery is case-insensitive so provider aliases such as `etched` and
  // `Etched` cannot re-enter the review queue. The observed board spelling is
  // still retained exactly for every candidate that is not already registered.
  const registered = new Set([...options.registeredBoards ?? []].map((board) => board.toLowerCase()));
  const observedAt = options.observedAt ?? new Date().toISOString();
  type Tally = { companies: Map<string, number>; sources: Set<string>; locations: Set<string>; roleCount: number; sampleJobUrl: string };
  const byBoard = new Map<string, Tally>();
  for (const sighting of sightings) {
    const boardName = ashbyBoardNameFromUrl(sighting.applyUrl);
    if (!boardName || registered.has(boardName.toLowerCase())) continue;
    const tally = byBoard.get(boardName) ?? { companies: new Map(), sources: new Set(), locations: new Set(), roleCount: 0, sampleJobUrl: '' };
    const company = sighting.company.trim();
    if (company) tally.companies.set(company, (tally.companies.get(company) ?? 0) + 1);
    if (sighting.location.trim()) tally.locations.add(sighting.location.trim());
    tally.sources.add(sighting.sourceId);
    tally.roleCount += 1;
    tally.sampleJobUrl ||= sighting.applyUrl;
    byBoard.set(boardName, tally);
  }
  return [...byBoard.entries()].map(([boardName, tally]) => {
    const variants = [...tally.companies].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    return {
      boardName,
      observedCompany: variants[0] ?? '',
      observedCompanyVariants: variants,
      referencingSources: [...tally.sources].sort(),
      roleCount: tally.roleCount,
      geographicCoverage: [...tally.locations].sort(),
      sampleJobUrl: tally.sampleJobUrl,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      reviewState: (variants.length > 1 ? 'ambiguous-owner' : 'pending-review') as AshbyReviewState,
    };
  }).sort((a, b) => b.roleCount - a.roleCount || a.boardName.localeCompare(b.boardName));
}
