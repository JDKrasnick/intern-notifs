import { htmlToText } from './core/early-career.js';
import { metadataDescriptionText } from './core/metadata-text.js';
import type { ProviderIdentity } from './types.js';
import type { RoleMetadataArtifact } from './role-metadata.js';

export type MetadataAcquisition = {
  method: 'greenhouse-api' | 'lever-api' | 'ashby-api' | 'workday-api' | 'smartrecruiters-api';
  sourceUrl: string;
  outcome: 'acquired' | 'failed' | 'identity-mismatch' | 'incomplete';
  artifact?: RoleMetadataArtifact;
  status?: number;
  bytes?: number;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? htmlToText(value) : '';
const description = (value: unknown) => typeof value === 'string' ? metadataDescriptionText(value) : '';
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const periods: Record<string, string> = { 'per-hour-wage': 'hour', 'per-day-wage': 'day', 'per-week-salary': 'week', 'per-month-salary': 'month', 'per-year-salary': 'year',
  'bi-week-salary': 'biweekly', 'semi-month-salary': 'semimonthly', 'bi-month-salary': 'bimonthly', 'one-time': 'one-time' };

/** Only reviewed/extracted provider identities can select a fixed public API host.
 * A company name, title, or employer-domain URL is never a tenant guess. */
export function metadataApiRoute(identity: ProviderIdentity, candidateUrl?: string): { method: MetadataAcquisition['method']; url: string; identity?: ProviderIdentity } | undefined {
  const { provider, tenant, postingId } = identity;
  if (candidateUrl) {
    try {
      const url = new URL(candidateUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
      // Embedded Greenhouse forms expose the board and immutable posting in
      // `for`/`token`. Recover only that observed identity, not the signed form
      // token, and reject duplicate parameters or disagreement with known IDs.
      const board = url.searchParams.get('for');
      const embeddedId = url.searchParams.get('token');
      if (provider === 'greenhouse' && ['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname)
        && url.pathname === '/embed/job_app' && board && /^[a-z0-9_-]{1,100}$/iu.test(board)
        && embeddedId === postingId && /^\d+$/u.test(embeddedId)
        && url.searchParams.getAll('for').length === 1 && url.searchParams.getAll('token').length === 1
        && (!tenant || tenant.toLowerCase() === board.toLowerCase())) return {
        method: 'greenhouse-api', url: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${postingId}?pay_transparency=true&pay_input_ranges=true`,
        identity: { ...identity, tenant: board },
      };
      const smart = /^\/([a-z0-9_-]+)\/(\d+)(?:-[^/]*)?\/?$/iu.exec(url.pathname);
      if (url.hostname === 'jobs.smartrecruiters.com' && smart) return {
        method: 'smartrecruiters-api', url: `https://api.smartrecruiters.com/v1/companies/${smart[1]}/postings/${smart[2]}`,
        identity: { ...identity, tenant: smart[1], postingId: smart[2] },
      };
      const workday = /^\/((?:[a-z]{2}-[A-Z]{2}\/)?)([a-z0-9_-]+)\/job\/(.+)$/iu.exec(url.pathname);
      if (provider === 'workday' && tenant && postingId && workday
        && new RegExp(`^${tenant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.wd\\d+\\.myworkdayjobs\\.com$`, 'iu').test(url.hostname)
        && workday[3]!.toLowerCase().endsWith(`_${postingId.toLowerCase()}`)) return {
        method: 'workday-api', url: `${url.origin}/wday/cxs/${tenant}/${workday[2]}/job/${workday[3]}`,
      };
    } catch { return undefined; }
  }
  // Ashby board names can contain dots (for example persona.ai). Dots are
  // literal path-segment characters, never a host or traversal instruction.
  const validTenant = tenant && tenant.length <= 100 && (provider === 'ashby'
    ? /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/iu.test(tenant) : /^[a-z0-9_-]+$/iu.test(tenant));
  if (!validTenant || !postingId) return undefined;
  if (provider === 'greenhouse' && /^\d+$/u.test(postingId)) return {
    method: 'greenhouse-api', url: `https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs/${postingId}?pay_transparency=true&pay_input_ranges=true`,
  };
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(postingId)) return undefined;
  if (provider === 'lever') return { method: 'lever-api', url: `https://api.lever.co/v0/postings/${tenant}/${postingId}?mode=json` };
  if (provider === 'ashby') return { method: 'ashby-api', url: `https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true` };
  return undefined;
}

function bandText(value: unknown): string {
  if (!record(value) || typeof value.min !== 'number' || typeof value.max !== 'number'
    || !Number.isFinite(value.min) || !Number.isFinite(value.max) || value.min <= 0 || value.max < value.min
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) return '';
  // An explicitly nonstandard interval must not be misrepresented as unknown.
  const period = typeof value.interval === 'string' ? periods[value.interval] : undefined;
  if (value.interval && !period) return '';
  return `Salary: ${value.currency} ${value.min} - ${value.max}${period ? ` per ${period}` : ''}`;
}

export function parseMetadataApiResponse(identity: ProviderIdentity, method: MetadataAcquisition['method'], payload: unknown, requestUrl?: string): RoleMetadataArtifact | undefined {
  if (!record(payload)) return undefined;
  const expected = identity.postingId;
  if (method === 'workday-api') {
    const job = payload.jobPostingInfo;
    if (!record(job) || !text(job.title) || !text(job.jobDescription)) return undefined;
    let presentation: string | undefined;
    try { presentation = requestUrl ? decodeURIComponent(new URL(requestUrl).pathname.split('/').at(-1) ?? '').toLowerCase() : undefined; }
    catch { return undefined; }
    const returnedPresentation = text(job.jobPostingId).toLowerCase();
    const exactPresentation = presentation && returnedPresentation === presentation && presentation.endsWith(`_${expected?.toLowerCase()}`);
    const exactRequisition = text(job.jobReqId).toLowerCase() === expected?.toLowerCase()
      && (!presentation || !returnedPresentation || returnedPresentation === presentation);
    // Workday's published presentation can have a suffix (-1/-2). Validate
    // its entire returned slug instead of stripping suffixes or merging IDs.
    if (!exactPresentation && !exactRequisition) return undefined;
    return { title: text(job.title), text: description(job.jobDescription),
      locations: [text(job.location), ...strings(job.additionalLocations)].filter(Boolean), deadline: text(job.endDate) || undefined };
  }
  if (method === 'smartrecruiters-api') {
    if (String(payload.id) !== expected || !record(payload.company) || text(payload.company.identifier).toLowerCase() !== identity.tenant?.toLowerCase()
      || !text(payload.name) || !record(payload.jobAd) || !record(payload.jobAd.sections)) return undefined;
    const sections = payload.jobAd.sections;
    const content = ['jobDescription', 'qualifications', 'additionalInformation'].flatMap((key) => record(sections[key]) ? [description(sections[key].text)] : []).filter(Boolean).join('\n');
    if (!content) return undefined;
    const location = record(payload.location) ? payload.location : {};
    return { title: text(payload.name), text: content, locations: [text(location.fullLocation) || [location.city, location.region, location.country].map(text).filter(Boolean).join(', ')].filter(Boolean),
      workMode: location.hybrid === true ? 'hybrid' : location.remote === true ? 'remote' : undefined,
      publishedAt: text(payload.releasedDate) || undefined };
  }
  if (method === 'greenhouse-api') {
    if (String(payload.id) !== expected || !text(payload.title) || typeof payload.content !== 'string') return undefined;
    const ranges = Array.isArray(payload.pay_input_ranges) ? payload.pay_input_ranges.flatMap((range) => {
      if (!record(range) || typeof range.min_cents !== 'number' || typeof range.max_cents !== 'number') return [];
      const band = bandText({ min: range.min_cents / 100, max: range.max_cents / 100, currency: range.currency_type });
      // Greenhouse does not supply a period in the structured range contract.
      // Only an explicit period in its publisher label supplies a unit.
      const label = text(range.title);
      const period = /\bhourly (?:rate|pay|salary)\b/iu.test(label) ? 'hourly' as const
        : /\bannual (?:rate|pay|salary)\b/iu.test(label) ? 'annual' as const : undefined;
      return band ? [{ minAmount: range.min_cents / 100, maxAmount: range.max_cents / 100,
        currency: text(range.currency_type), period, label: label || undefined,
        sourceText: `${text(range.title)}: ${band}. ${text(range.blurb)}` }] : [];
    }) : [];
    return { title: text(payload.title), text: description(payload.content), compensationBands: ranges,
      locations: record(payload.location) ? [text(payload.location.name)].filter(Boolean) : [],
      publishedAt: text(payload.first_published) || undefined, updatedAt: text(payload.updated_at) || undefined,
      deadline: text(payload.application_deadline) || undefined };
  }
  if (method === 'lever-api') {
    if (payload.id !== expected || !text(payload.text)) return undefined;
    try {
      const url = new URL(String(payload.hostedUrl));
      if (url.origin !== 'https://jobs.lever.co' || url.pathname.replace(/\/$/u, '') !== `/${identity.tenant}/${expected}`) return undefined;
    } catch { return undefined; }
    const sections = Array.isArray(payload.lists) ? payload.lists.flatMap((item) => record(item) ? [text(item.text), description(item.content)] : []) : [];
    const descriptions = [payload.descriptionPlain, payload.description, payload.additionalPlain, payload.additional].map(description);
    if (!descriptions.some(Boolean)) return undefined;
    const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).valueOf()) ? new Date(value).toISOString() : undefined;
    return { title: text(payload.text), text: [...descriptions, ...sections].filter(Boolean).join('\n'),
      compensationText: [bandText(payload.salaryRange), description(payload.salaryDescriptionPlain), description(payload.salaryDescription)].filter(Boolean).join('\n'),
      locations: record(payload.categories) ? [text(payload.categories.location), ...strings(payload.categories.allLocations)].filter(Boolean) : [],
      workMode: text(payload.workplaceType) || undefined, publishedAt: timestamp(payload.createdAt), updatedAt: timestamp(payload.updatedAt) };
  }
  if (!Array.isArray(payload.jobs)) return undefined;
  const matches = payload.jobs.filter((row) => record(row) && row.id === expected);
  if (matches.length !== 1 || !record(matches[0])) return undefined;
  const job = matches[0];
  try {
    const url = new URL(String(job.jobUrl));
    if (url.origin !== 'https://jobs.ashbyhq.com' || url.pathname.replace(/\/$/u, '') !== `/${identity.tenant}/${expected}`) return undefined;
  } catch { return undefined; }
  if (!text(job.title) || ![job.descriptionPlain, job.descriptionHtml].some((value) => text(value))) return undefined;
  return { title: text(job.title), text: [job.descriptionPlain, job.descriptionHtml].map(description).filter(Boolean).join('\n'),
    compensationText: record(job.compensation) ? [job.compensation.scrapeableCompensationSalarySummary, job.compensation.compensationTierSummary].map(description).filter(Boolean).join('\n') : undefined,
    locations: [text(job.location), ...(Array.isArray(job.secondaryLocations) ? job.secondaryLocations.flatMap((item) => record(item) ? [text(item.location)] : []) : [])].filter(Boolean),
    workMode: text(job.workplaceType) || undefined, publishedAt: text(job.publishedAt) || undefined };
}

/** A request/batch-scoped cache, not isolate-global I/O state. Hosts, redirects,
 * content type, timeout and streamed byte budget are checked before parsing. */
export function createMetadataAcquirer(fetchImpl: typeof fetch = fetch, hooks: {
  canRequest?: (host: string) => Promise<boolean>;
  deferHost?: (host: string, retryAfter: string) => Promise<void>;
} = {}) {
  const requests = new Map<string, Promise<{ payload?: unknown; status?: number; bytes?: number; outcome: MetadataAcquisition['outcome'] }>>();
  const throttled = new Set<string>();
  return async (identity: ProviderIdentity, candidateUrl?: string): Promise<MetadataAcquisition | undefined> => {
    const route = metadataApiRoute(identity, candidateUrl);
    if (!route) return undefined;
    if (!requests.has(route.url)) requests.set(route.url, (async () => {
      try {
        const host = new URL(route.url).hostname;
        if (throttled.has(host) || (hooks.canRequest && !await hooks.canRequest(host))) return { outcome: 'failed' as const, status: 429 };
        // workerd rejects redirect:'error' before issuing the request. Manual
        // mode plus the non-2xx check below rejects redirects without following.
        const response = await fetchImpl(route.url, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
        if (response.status === 429) {
          throttled.add(host);
          const header = response.headers.get('retry-after');
          const parsed = header && /^\d+$/u.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header ?? '');
          const until = new Date(Number.isFinite(parsed) ? Math.max(Date.now() + 60_000, Math.min(parsed, Date.now() + 86_400_000)) : Date.now() + 3_600_000).toISOString();
          await hooks.deferHost?.(host, until);
        }
        if (!response.ok || !/\bapplication\/json\b/iu.test(response.headers.get('content-type') ?? '')) {
          await response.body?.cancel(); return { outcome: 'failed' as const, status: response.status };
        }
        const reader = response.body?.getReader();
        if (!reader) return { outcome: 'incomplete' as const, status: response.status };
        const decoder = new TextDecoder(); let body = ''; let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2_000_000) { await reader.cancel(); return { outcome: 'incomplete' as const, status: response.status, bytes }; }
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
        } finally { reader.releaseLock(); }
        return { outcome: 'acquired' as const, payload: JSON.parse(body) as unknown, bytes, status: response.status };
      } catch { return { outcome: 'failed' as const }; }
    })());
    const result = await requests.get(route.url)!;
    const artifact = result.payload ? parseMetadataApiResponse(route.identity ?? identity, route.method, result.payload, route.url) : undefined;
    return { method: route.method, sourceUrl: route.url, status: result.status, bytes: result.bytes,
      outcome: result.outcome === 'acquired' && !artifact ? 'identity-mismatch' : result.outcome, ...(artifact ? { artifact } : {}) };
  };
}
