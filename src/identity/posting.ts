import { createHash } from 'node:crypto';
import type { PostingAlias, PostingIdentity, PostingProvider } from '../types.js';

const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]);

function withoutTrailingSlash(pathname: string): string {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
}

/** Canonicalizes only syntax and reviewed provider presentation variants. */
export function canonicalizePostingUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Posting URL must use HTTP or HTTPS');
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMETERS.has(lower) || lower.startsWith('utm_')) url.searchParams.delete(key);
  }

  const host = url.hostname.replace(/^www\./, '');
  let match: RegExpExecArray | null;
  if (host === 'jobs.ashbyhq.com' && (match = /^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/i.exec(url.pathname))) {
    url.pathname = `/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
    url.searchParams.delete('embed');
  } else if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
      && (match = /^\/([^/]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${match[1]!.toLowerCase()}/jobs/${match[2]}`;
    if (url.searchParams.get('gh_jid') === match[2]) url.searchParams.delete('gh_jid');
  } else if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
      && /^\d+$/.test(url.searchParams.get('gh_jid') ?? '')
      && (match = /^\/([^/]+)\/?$/i.exec(url.pathname))) {
    const postingId = url.searchParams.get('gh_jid')!;
    url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${match[1]!.toLowerCase()}/jobs/${postingId}`;
    url.searchParams.delete('gh_jid');
  } else {
    url.pathname = withoutTrailingSlash(url.pathname);
  }
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

export interface ProviderPostingReference {
  provider: PostingProvider;
  tenant?: string;
  postingId?: string;
}

/** Extracts immutable IDs only from reviewed routes. */
export function providerPostingReference(input: string): ProviderPostingReference {
  const url = new URL(canonicalizePostingUrl(input));
  const host = url.hostname.replace(/^www\./, '');
  let match: RegExpExecArray | null;
  if (host === 'job-boards.greenhouse.io' && (match = /^\/([^/]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'greenhouse', tenant: match[1]!.toLowerCase(), postingId: match[2] };
  }
  if (host === 'jobs.lever.co' && (match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/i.exec(url.pathname))) {
    return { provider: 'lever', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host === 'jobs.ashbyhq.com' && (match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/application)?\/?$/i.exec(url.pathname))) {
    return { provider: 'ashby', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if ((host === 'lifeattiktok.com' || host === 'joinbytedance.com') && (match = /^\/(?:search|position)\/(\d+)(?:\/detail)?\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host === 'jobs.bytedance.com' && (match = /^\/[a-z-]+\/position\/(\d+)(?:\/detail)?\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host.endsWith('.myworkdayjobs.com') && (match = /_([^/_]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'workday', tenant: host.split('.')[0]!.toLowerCase(), postingId: match[1]!.toLowerCase() };
  }
  return { provider: 'unknown' };
}

export function providerPostingAlias(reference: ProviderPostingReference): string | undefined {
  if (!reference.postingId || reference.provider === 'unknown') return undefined;
  return `provider:${reference.provider}:${reference.tenant ?? '-'}:${reference.postingId}`;
}

export function exactPostingKey(input: string): string {
  const canonicalUrl = canonicalizePostingUrl(input);
  return providerPostingAlias(providerPostingReference(canonicalUrl)) ?? `url:${canonicalUrl}`;
}

export function stableCanonicalJobId(exactKey: string): string {
  return createHash('sha256').update(`posting-v1:${exactKey}`).digest('hex').slice(0, 32);
}

export interface BuildPostingIdentityInput {
  applicationUrl: string;
  observedUrls?: string[];
  finalOfficialUrl?: string;
  employerId?: string;
  employerRequisitionId?: string;
  employerRequisitionAuthoritative?: boolean;
}

function alias(kind: PostingAlias['kind'], value: string, sourceUrl?: string): PostingAlias {
  return sourceUrl ? { kind, value, sourceUrl } : { kind, value };
}

export function buildPostingIdentity(input: BuildPostingIdentityInput): PostingIdentity {
  const urls = [input.applicationUrl, ...(input.observedUrls ?? []), ...(input.finalOfficialUrl ? [input.finalOfficialUrl] : [])];
  const canonicalApplicationUrl = canonicalizePostingUrl(input.finalOfficialUrl ?? input.applicationUrl);
  const references = urls.map(providerPostingReference);
  const reference = references.find((candidate) => candidate.postingId) ?? { provider: 'unknown' as const };
  const aliases: PostingAlias[] = [];
  for (const url of urls) {
    const canonicalUrl = canonicalizePostingUrl(url);
    const providerAlias = providerPostingAlias(providerPostingReference(url));
    if (providerAlias) aliases.push(alias('provider-route', providerAlias, url));
    aliases.push(alias(url === input.finalOfficialUrl ? 'official-url' : 'application-url', `url:${canonicalUrl}`, url));
  }
  const primaryProviderAlias = providerPostingAlias(reference);
  if (primaryProviderAlias) aliases.push(alias('provider-posting', primaryProviderAlias));
  if (input.employerRequisitionAuthoritative && input.employerRequisitionId && input.employerId) {
    aliases.push(alias('employer-requisition', `requisition:${input.employerId}:${input.employerRequisitionId.trim().toLowerCase()}`));
  }
  const uniqueAliases = [...new Map(aliases.map((item) => [`${item.kind}:${item.value}`, item])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
  const exactKey = primaryProviderAlias
    ?? uniqueAliases.find((item) => item.kind === 'employer-requisition')?.value
    ?? `url:${canonicalApplicationUrl}`;
  return {
    provider: reference.provider,
    ...(reference.tenant ? { tenant: reference.tenant } : {}),
    ...(reference.postingId ? { providerPostingId: reference.postingId } : {}),
    ...(input.employerRequisitionId ? { employerRequisitionId: input.employerRequisitionId } : {}),
    ...(input.employerRequisitionAuthoritative !== undefined ? { employerRequisitionAuthoritative: input.employerRequisitionAuthoritative } : {}),
    canonicalApplicationUrl,
    aliases: uniqueAliases,
    canonicalJobId: stableCanonicalJobId(exactKey),
  };
}

export type AliasResolution =
  | { outcome: 'create'; canonicalJobId: string; aliases: string[] }
  | { outcome: 'merge'; canonicalJobId: string; aliases: string[] }
  | {
      outcome: 'quarantine';
      aliases: string[];
      conflictingCanonicalJobIds: string[];
      reason: 'aliases-resolve-to-different-jobs' | 'multiple-immutable-provider-postings';
    };

/** Pure decision used before an atomic alias-registry transaction. */
export function resolvePostingAliases(identity: PostingIdentity, claims: ReadonlyMap<string, string>): AliasResolution {
  const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
  const providerPostingGroups = new Map<string, Set<string>>();
  for (const value of aliases.filter((item) => item.startsWith('provider:'))) {
    const [, provider, tenant, postingId] = value.split(':');
    if (!provider || !tenant || !postingId) continue;
    const group = `${provider}:${tenant}`;
    const ids = providerPostingGroups.get(group) ?? new Set<string>();
    ids.add(postingId);
    providerPostingGroups.set(group, ids);
  }
  if ([...providerPostingGroups.values()].some((ids) => ids.size > 1)) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'multiple-immutable-provider-postings' };
  }
  const claimedIds = [...new Set(aliases.map((item) => claims.get(item)).filter((item): item is string => Boolean(item)))].sort();
  if (claimedIds.length > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: claimedIds, reason: 'aliases-resolve-to-different-jobs' };
  }
  if (claimedIds.length === 1) return { outcome: 'merge', canonicalJobId: claimedIds[0]!, aliases };
  return { outcome: 'create', canonicalJobId: identity.canonicalJobId, aliases };
}
