/** Read-only probe for Ashby's fixed public job-board endpoint. */
import { hasLifecycleTitleSignal } from '../core/early-career.js';
import { assessTechnicalRole } from '../core/filters.js';
import { ASHBY_JOB_HOST, validateAshbyBoardName } from './ashby-ledger.js';

export const ASHBY_API_HOST = 'api.ashbyhq.com';
export const ASHBY_API_VERSION = '1';

export interface AshbyListedRoleSample {
  id: string;
  title: string;
  location: string;
}

export type AshbyProbeResult = {
  state: 'ok';
  boardName: string;
  endpoint: string;
  apiVersion: '1';
  apiRegion: 'global';
  rawRows: number;
  listedRows: number;
  unlistedRows: number;
  malformedRows: number;
  boardPathViolations: number;
  technicalEarlyCareerRoles: number;
  geographicCoverage: string[];
  applicationHostSummary: Record<string, number>;
  qualifyingRoleSamples: AshbyListedRoleSample[];
} | {
  state: 'invalid-board' | 'not-found' | 'http-error' | 'transport-error' | 'redirect-error' | 'json-error' | 'api-version-error' | 'schema-error';
  boardName: string;
  endpoint: string;
  status?: number;
  observedApiVersion?: unknown;
  inconclusive?: boolean;
};

export function ashbyEndpoint(boardName: string): string {
  return `https://${ASHBY_API_HOST}/posting-api/job-board/${encodeURIComponent(boardName)}`;
}

interface AshbyRow {
  id: string;
  title: string;
  location: string;
  isListed: boolean;
  jobUrl: string;
  applyUrl: string;
  employmentType?: string;
}

function isRow(value: unknown): value is AshbyRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['id', 'title', 'location', 'jobUrl', 'applyUrl'].every((key) => typeof row[key] === 'string')
    && typeof row.isListed === 'boolean'
    && (row.employmentType === undefined || typeof row.employmentType === 'string');
}

function pathMatches(urlValue: string, boardName: string, id: string, application: boolean): boolean {
  let url: URL;
  try { url = new URL(urlValue); } catch { return false; }
  const suffix = application ? '/application' : '';
  return url.protocol === 'https:'
    && url.hostname.toLowerCase() === ASHBY_JOB_HOST
    && (!url.port || url.port === '443')
    && url.pathname === `/${boardName}/${id}${suffix}`;
}

export function ashbyRowPathViolation(row: Pick<AshbyRow, 'id' | 'jobUrl' | 'applyUrl'>, boardName: string): string | undefined {
  if (!pathMatches(row.jobUrl, boardName, row.id, false)) return 'jobUrl does not match the exact board and job path';
  // Custom employer-controlled application hosts are reviewable exceptions. An
  // Ashby-hosted application URL, however, must obey the exact path contract.
  let apply: URL;
  try { apply = new URL(row.applyUrl); } catch { return 'applyUrl is not a URL'; }
  if (apply.hostname.toLowerCase() === ASHBY_JOB_HOST && !pathMatches(row.applyUrl, boardName, row.id, true)) {
    return 'applyUrl does not match the exact board and application path';
  }
  if (apply.protocol !== 'https:') return 'applyUrl does not use HTTPS';
  return undefined;
}

function qualifies(row: AshbyRow): boolean {
  const earlyCareer = row.employmentType?.toLowerCase() === 'intern' || hasLifecycleTitleSignal(row.title);
  if (!earlyCareer) return false;
  return assessTechnicalRole({ company: '', title: row.title, location: '', season: '' }).technical;
}

export async function probeAshbyBoard(
  boardName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AshbyProbeResult> {
  const endpoint = ashbyEndpoint(boardName);
  if (!validateAshbyBoardName(boardName)) return { state: 'invalid-board', boardName, endpoint };
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { headers: { Accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch {
    return { state: 'transport-error', boardName, endpoint, inconclusive: true };
  }
  if (response.status === 404) return { state: 'not-found', boardName, endpoint, status: 404 };
  if (!response.ok) return { state: 'http-error', boardName, endpoint, status: response.status };
  if (response.redirected || (response.url && response.url !== endpoint)) return { state: 'redirect-error', boardName, endpoint };
  let payload: unknown;
  try { payload = await response.json(); } catch { return { state: 'json-error', boardName, endpoint }; }
  if (!payload || typeof payload !== 'object') return { state: 'schema-error', boardName, endpoint };
  const root = payload as Record<string, unknown>;
  if (root.apiVersion !== ASHBY_API_VERSION) {
    return { state: 'api-version-error', boardName, endpoint, observedApiVersion: root.apiVersion };
  }
  if (!Array.isArray(root.jobs)) return { state: 'schema-error', boardName, endpoint };

  let malformedRows = 0;
  let unlistedRows = 0;
  let boardPathViolations = 0;
  const listed: AshbyRow[] = [];
  const hosts: Record<string, number> = {};
  for (const value of root.jobs) {
    if (!isRow(value)) { malformedRows += 1; continue; }
    if (!value.isListed) { unlistedRows += 1; continue; }
    listed.push(value);
    try {
      const host = new URL(value.applyUrl).hostname.toLowerCase();
      hosts[host] = (hosts[host] ?? 0) + 1;
    } catch { /* Counted by the path contract below. */ }
    if (ashbyRowPathViolation(value, boardName)) boardPathViolations += 1;
  }
  const qualifying = listed.filter(qualifies);
  return {
    state: 'ok', boardName, endpoint, apiVersion: ASHBY_API_VERSION, apiRegion: 'global',
    rawRows: root.jobs.length, listedRows: listed.length, unlistedRows, malformedRows, boardPathViolations,
    technicalEarlyCareerRoles: qualifying.length,
    geographicCoverage: [...new Set(listed.map((row) => row.location.trim()).filter(Boolean))].sort(),
    applicationHostSummary: Object.fromEntries(Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b))),
    qualifyingRoleSamples: qualifying.slice(0, 5).map(({ id, title, location }) => ({ id, title, location })),
  };
}
