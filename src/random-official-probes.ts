/**
 * Read-only, provider-neutral spot checks for catalog roles backed by one
 * exact official ATS occurrence.  This is deliberately an audit: it never
 * enqueues, writes, repairs, or treats an unavailable publisher as a pass.
 */
import { createHash } from 'node:crypto';
import { metadataApiRoute, parseMetadataApiResponse } from './metadata-acquisition.js';
import { extractPostingMetadataEvidence, reconcileRoleMetadata } from './role-metadata.js';
import type { ProviderIdentity } from './types.js';

type Json = Record<string, unknown>;
type Fetch = typeof fetch;
export const RANDOM_OFFICIAL_PROBE_TIMEOUT_MS = 12_000;
/** A guard against a looping or hostile cursor; reaching it is an audit error,
 * never permission to sample a biased catalog prefix. */
export const RANDOM_OFFICIAL_PROBE_MAX_PAGES = 2_000;
export type RandomOfficialProbeState = 'ok' | 'discrepant' | 'unsupported' | 'unavailable' | 'blocked';
export type RandomOfficialProbeResult = {
  jobId: string; seed: string; state: RandomOfficialProbeState; provider?: string; sourceId?: string;
  officialUrl?: string; discrepancies: string[]; receipt: string;
};
export type RandomOfficialProbeRun = { seed: string; checkedAt: string; readOnly: true; candidates: number; selected: number; results: RandomOfficialProbeResult[]; receipt: string };

const record = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : record(value)
  ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}` : JSON.stringify(value);
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function random(seed: string) { let n = Number.parseInt(digest(seed).slice(0, 8), 16) >>> 0; return () => { n += 0x6D2B79F5; let t = n; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 2 ** 32; }; }
function shuffled<T>(rows: readonly T[], seed: string) { const copy = [...rows]; const next = random(seed); for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; } return copy; }

function providerIdentity(job: Json): { identity: ProviderIdentity; reference: Json } | undefined {
  const refs = Array.isArray(job.sourceReferences) ? job.sourceReferences.filter(record) : [];
  // A single occurrence avoids silently checking a merged canonical role
  // against the wrong employer posting.
  if (refs.length !== 1) return undefined;
  const reference = refs[0]!; const evidence = record(reference.providerEvidence) ? reference.providerEvidence : undefined;
  const provider = string(evidence?.provider); const tenant = string(evidence?.tenant); const postingId = string(evidence?.postingId);
  if (!provider || !tenant || !postingId || !['greenhouse', 'lever', 'ashby'].includes(provider)) return undefined;
  const sourceId = string(reference.sourceId); const sourceUrl = string(reference.sourceUrl);
  if (!sourceId || !sourceUrl) return undefined;
  return { reference, identity: { provider: provider as ProviderIdentity['provider'], tenant, postingId, sourceId, sourceUrl } };
}

function sameLocations(job: Json, locations: string[]) {
  const publicLocations = (Array.isArray(job.locations) ? job.locations : [job.location]).map(string).filter((v): v is string => Boolean(v));
  if (!locations.length || !publicLocations.length) return [];
  const expected = new Set(locations.map(normalized)); const actual = new Set(publicLocations.map(normalized));
  return [...expected].every(value => actual.has(value)) && [...actual].every(value => expected.has(value)) ? [] : [`locations: official ${JSON.stringify(locations)}, public ${JSON.stringify(publicLocations)}`];
}

function exactDestination(identity: ProviderIdentity, value: unknown): boolean {
  const urlText = string(value); if (!urlText) return false;
  try { const url = new URL(urlText); const tenant = identity.tenant!; const id = identity.postingId!;
    if (url.protocol !== 'https:') return false;
    // Reviewed sources may use an employer-controlled application host. Its
    // exact value is bound by the occurrence evidence, so only impose an ATS
    // path contract if the public URL is actually on that ATS host.
    if (identity.provider === 'greenhouse') return !['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname) || (url.pathname === `/${tenant}/jobs/${id}` || (url.pathname === '/embed/job_app' && url.searchParams.get('for') === tenant && url.searchParams.get('token') === id));
    if (identity.provider === 'lever') return url.hostname !== 'jobs.lever.co' || url.pathname.replace(/\/$/u, '') === `/${tenant}/${id}/apply`;
    return url.hostname !== 'jobs.ashbyhq.com' || url.pathname === `/${tenant}/${id}/application`;
  } catch { return false; }
}

async function getJson(url: string, fetchImpl: Fetch, timeoutMs: number): Promise<{ state: 'ok' | 'blocked' | 'unavailable'; status?: number; body?: unknown }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) return { state: response.status === 401 || response.status === 403 ? 'blocked' : 'unavailable', status: response.status };
    try { return { state: 'ok', status: response.status, body: await response.json() }; } catch { return { state: 'unavailable', status: response.status }; }
  } catch { return { state: 'unavailable' }; } finally { clearTimeout(timer); }
}

export async function runRandomOfficialProbes(options: { apiUrl?: string; count?: number; seed?: string; fetchImpl?: Fetch; timeoutMs?: number; maxPages?: number; now?: () => Date } = {}): Promise<RandomOfficialProbeRun> {
  const apiUrl = (options.apiUrl ?? 'https://intern-notifs.jdkrasnick.workers.dev').replace(/\/$/u, ''); const fetchImpl = options.fetchImpl ?? fetch;
  const count = options.count ?? 10; const seed = options.seed ?? `${options.now?.() ?? new Date()}`; const timeoutMs = options.timeoutMs ?? RANDOM_OFFICIAL_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('count must be an integer from 1 to 50');
  const jobs: Json[] = []; let cursor: string | undefined; const maxPages = options.maxPages ?? RANDOM_OFFICIAL_PROBE_MAX_PAGES;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await getJson(`${apiUrl}/jobs?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, fetchImpl, timeoutMs);
    if (result.state !== 'ok' || !record(result.body) || !Array.isArray(result.body.jobs)) throw new Error(`Unable to read the complete public catalog${result.status ? ` (${result.status})` : ''}`);
    jobs.push(...result.body.jobs.filter(record)); cursor = string(result.body.cursor); if (!cursor) break;
    if (page + 1 === maxPages) throw new Error(`Public catalog exceeded the explicit ${maxPages}-page audit cap; no biased prefix was sampled`);
  }
  const candidates = jobs.filter(providerIdentity); const selected = shuffled(candidates, seed).slice(0, count);
  const results = await Promise.all(selected.map(async (job): Promise<RandomOfficialProbeResult> => {
    const candidate = providerIdentity(job)!; const route = metadataApiRoute(candidate.identity, string(candidate.reference.applyUrl));
    const base = { jobId: String(job.jobId), seed, provider: candidate.identity.provider, sourceId: candidate.identity.sourceId, officialUrl: route?.url, discrepancies: [] as string[] };
    if (!route || !['greenhouse-api', 'lever-api', 'ashby-api'].includes(route.method)) return { ...base, state: 'unsupported', receipt: digest(base) };
    const official = await getJson(route.url, fetchImpl, timeoutMs);
    if (official.state !== 'ok') return { ...base, state: official.state, discrepancies: [`official endpoint ${official.state}${official.status ? ` (${official.status})` : ''}`], receipt: digest({ ...base, official }) };
    const artifact = parseMetadataApiResponse(candidate.identity, route.method, official.body, string(candidate.reference.applyUrl));
    if (!artifact) return { ...base, state: 'discrepant', discrepancies: ['official payload did not satisfy exact provider identity/description contract'], receipt: digest({ ...base, official: 'identity-mismatch' }) };
    const discrepancies = [
      ...(normalized(String(job.title ?? '')) === normalized(artifact.title) ? [] : [`title: official ${JSON.stringify(artifact.title)}, public ${JSON.stringify(job.title)}`]),
      ...sameLocations(job, artifact.locations ?? []),
      ...(exactDestination(candidate.identity, job.applyUrl) && string(job.applyUrl) === string(candidate.reference.applyUrl) ? [] : ['applyUrl: public destination does not equal the exact official ATS destination']),
    ];
    const evidence = extractPostingMetadataEvidence({ artifact, sourceClass: 'official-ats', sourceId: candidate.identity.sourceId, sourceUrl: route.url, observedAt: options.now?.().toISOString() ?? new Date().toISOString(), exactPosting: true });
    const expected = reconcileRoleMetadata(evidence).metadata;
    // Compare only fields positively extracted by the shared parser. Absence
    // is unknown, never a claim that a public field must be cleared.
    if (expected?.workMode && job.workMode !== expected.workMode.value) discrepancies.push(`workMode: official ${expected.workMode.value}, public ${String(job.workMode)}`);
    if (expected?.employerPublishedAt && job.employerPublishedAt !== expected.employerPublishedAt.value) discrepancies.push('employerPublishedAt differs from official description/API evidence');
    if (expected?.employerUpdatedAt && job.employerUpdatedAt !== expected.employerUpdatedAt.value) discrepancies.push('employerUpdatedAt differs from official description/API evidence');
    const result = { ...base, state: discrepancies.length ? 'discrepant' as const : 'ok' as const, discrepancies }; return { ...result, receipt: digest(result) };
  }));
  const run = { seed, checkedAt: options.now?.().toISOString() ?? new Date().toISOString(), readOnly: true as const, candidates: candidates.length, selected: results.length, results };
  return { ...run, receipt: digest(run) };
}
