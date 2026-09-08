/**
 * Read-only regression probes for three exact postings that previously exposed
 * metadata errors.  These are deliberately a tiny fixed set: they are an
 * acceptance signal, not a catalog audit or a repair mechanism.
 */
import { metadataApiRoute } from './metadata-acquisition.js';
import type { ProviderIdentity } from './types.js';

export const TRUSTED_CATALOG_PROBE_TIMEOUT_MS = 10_000;
export const TRUSTED_CATALOG_PROBES = [
  {
    name: 'Tenstorrent 5221670007', jobId: '6c4c30b940425616ed35536a7f99f2b6',
    identity: { provider: 'greenhouse', tenant: 'tenstorrentuniversity', postingId: '5221670007', sourceId: 'greenhouse-tenstorrentuniversity', sourceUrl: 'https://job-boards.greenhouse.io/tenstorrentuniversity' } satisfies ProviderIdentity,
    officialUrl: 'https://boards-api.greenhouse.io/v1/boards/tenstorrentuniversity/jobs/5221670007?pay_transparency=true&pay_input_ranges=true',
    official: (value: unknown) => check(value, [
      ['title', 'Software Engineering Intern (Oct 2026 start)'], ['location.name', 'Belgrade, Serbia'],
      ['first_published', '2026-08-26T14:58:59-04:00'], ['updated_at', '2026-09-02T17:54:05-04:00'],
    ]),
    public: (value: unknown) => [
      ...check(value, [['title', 'Software Engineering Intern (Oct 2026 start)'], ['location', 'Belgrade, Serbia'], ['workMode', 'onsite']]),
      ...absent(value, 'compensation.minAnnualUSD'), ...absent(value, 'housing'),
      ...different(value, 'employerPublishedAt', 'employerUpdatedAt'),
    ],
  },
  {
    name: 'Booz Allen R0248143', jobId: '684cee26d6cb3dda23029c8ff2a7b267',
    identity: { provider: 'workday', tenant: 'bah', postingId: 'R0248143', sourceId: 'workday-bah', sourceUrl: 'https://bah.wd1.myworkdayjobs.com/BAH_Jobs' } satisfies ProviderIdentity,
    officialUrl: 'https://bah.wd1.myworkdayjobs.com/wday/cxs/bah/BAH_Jobs/job/Rome-NY/University--2027-Summer-Games-Data-Scientist-Intern_R0248143',
    official: (value: unknown) => check(value, [
      ['jobPostingInfo.jobReqId', 'R0248143'], ['jobPostingInfo.title', 'University, 2027 Summer Games Data Scientist Intern - Rome, NY'],
      ['jobPostingInfo.location', 'Rome, NY'],
    ]),
    public: (value: unknown) => [
      ...check(value, [['title', 'University, 2027 Summer Games Data Scientist Intern - Rome, NY'], ['location', 'Rome, NY'], ['season', 'summer-2027'],
        ['compensation.minAnnualUSD', 61900], ['compensation.maxAnnualUSD', 141000]]),
      ...absent(value, 'workMode'),
    ],
  },
  {
    name: 'Fab2 0c4dc4f4-01c9-4138-a666-e7234cda7e95', jobId: 'af6115878b7beabcaf5d896865087496',
    identity: { provider: 'ashby', tenant: 'fab2', postingId: '0c4dc4f4-01c9-4138-a666-e7234cda7e95', sourceId: 'ashby-fab2', sourceUrl: 'https://jobs.ashbyhq.com/fab2' } satisfies ProviderIdentity,
    officialUrl: 'https://api.ashbyhq.com/posting-api/job-board/fab2?includeCompensation=true',
    official: (value: unknown) => {
      const jobs = record(value) && Array.isArray(value.jobs) ? value.jobs : [];
      const job = jobs.find((item) => record(item) && item.id === '0c4dc4f4-01c9-4138-a666-e7234cda7e95');
      return job ? check(job, [['title', 'Fab Software Engineering Intern - Winter'], ['location', 'Austin'], ['workplaceType', 'OnSite']]) : ['official.jobs: exact posting is unavailable'];
    },
    public: (value: unknown) => [
      ...check(value, [['title', 'Fab Software Engineering Intern - Winter'], ['workMode', 'onsite'],
        ['compensation.minAnnualUSD', 114000], ['compensation.maxAnnualUSD', 131000]]),
      ...containsAll(value, 'locations', ['Austin', 'San Francisco Office']), ...housingStipend(value),
    ],
  },
] as const;

type Probe = typeof TRUSTED_CATALOG_PROBES[number];
export type TrustedCatalogProbeResult = { name: string; jobId: string; state: 'ok' | 'discrepant' | 'unavailable' | 'blocked'; official: EndpointResult; public: EndpointResult; discrepancies: string[] };
type EndpointResult = { url: string; state: 'ok' | 'unavailable' | 'blocked'; status?: number; error?: string };
type Fetch = typeof fetch;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function at(value: unknown, path: string): unknown { return path.split('.').reduce<unknown>((current, key) => record(current) ? current[key] : undefined, value); }
function printed(value: unknown) { return value === undefined ? 'missing' : JSON.stringify(value); }
function check(value: unknown, expectations: Array<[string, unknown]>) { return expectations.flatMap(([path, expected]) => Object.is(at(value, path), expected) ? [] : [`${path}: expected ${printed(expected)}, got ${printed(at(value, path))}`]); }
function absent(value: unknown, path: string) { return at(value, path) === undefined ? [] : [`${path}: expected missing, got ${printed(at(value, path))}`]; }
function different(value: unknown, left: string, right: string) { const a = at(value, left); const b = at(value, right); return typeof a === 'string' && typeof b === 'string' && a !== b ? [] : [`${left}/${right}: expected distinct employer dates, got ${printed(a)}/${printed(b)}`]; }
function containsAll(value: unknown, path: string, expected: string[]) { const actual = at(value, path); return Array.isArray(actual) && expected.every((item) => actual.includes(item)) ? [] : [`${path}: expected to include ${expected.join(', ')}, got ${printed(actual)}`]; }
function housingStipend(value: unknown) { const housing = at(value, 'housing'); return Array.isArray(housing) && housing.some((item) => record(item) && item.kind === 'stipend' && item.minAmount === undefined && item.maxAmount === undefined) ? [] : ['housing: expected an amount-unknown stipend']; }

async function getJson(url: string, fetchImpl: Fetch, timeoutMs: number): Promise<{ endpoint: EndpointResult; body?: unknown }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return { endpoint: { url, state: response.status === 401 || response.status === 403 ? 'blocked' : 'unavailable', status: response.status } };
    try { return { endpoint: { url, state: 'ok', status: response.status }, body: await response.json() }; }
    catch { return { endpoint: { url, state: 'unavailable', status: response.status, error: 'response was not valid JSON' } }; }
  } catch (error) { return { endpoint: { url, state: 'unavailable', error: error instanceof Error && error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'request failed' } }; }
  finally { clearTimeout(timer); }
}

export async function recheckTrustedCatalogProbes(options: { fetchImpl?: Fetch; apiUrl?: string; timeoutMs?: number } = {}): Promise<TrustedCatalogProbeResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch; const apiUrl = (options.apiUrl ?? 'https://intern-notifs.jdkrasnick.workers.dev').replace(/\/$/u, '');
  const timeoutMs = options.timeoutMs ?? TRUSTED_CATALOG_PROBE_TIMEOUT_MS;
  return Promise.all(TRUSTED_CATALOG_PROBES.map(async (probe) => {
    const [official, publicJob] = await Promise.all([getJson(probe.officialUrl, fetchImpl, timeoutMs), getJson(`${apiUrl}/jobs/${probe.jobId}`, fetchImpl, timeoutMs)]);
    const discrepancies = [...(official.body === undefined ? [] : probe.official(official.body).map((item) => `official.${item}`)), ...(publicJob.body === undefined ? [] : probe.public(publicJob.body).map((item) => `public.${item}`))];
    const state = official.endpoint.state === 'blocked' || publicJob.endpoint.state === 'blocked' ? 'blocked'
      : official.endpoint.state !== 'ok' || publicJob.endpoint.state !== 'ok' ? 'unavailable' : discrepancies.length ? 'discrepant' : 'ok';
    return { name: probe.name, jobId: probe.jobId, state, official: official.endpoint, public: publicJob.endpoint, discrepancies };
  }));
}

/** Ensures the command's fixed official routes retain the reviewed provider identity. */
export function trustedCatalogProbeRoute(probe: Probe) { return metadataApiRoute(probe.identity, probe.identity.provider === 'workday' ? 'https://bah.wd1.myworkdayjobs.com/BAH_Jobs/job/Rome-NY/University--2027-Summer-Games-Data-Scientist-Intern_R0248143' : undefined); }
