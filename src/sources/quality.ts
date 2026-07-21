import type { SourceCheckpoint, SourceFetchResult } from '../types.js';

export type SourceClass = 'curated' | 'lever' | 'greenhouse' | 'ashby' | 'smartrecruiters';

export interface SourceQualityPolicy {
  id: string;
  sourceClass: SourceClass;
  /** Sources announced as dormant are checked for URL policy but exempt from row-count drift. */
  dormant?: boolean;
  leverSite?: string;
  /** Curated lists should represent the market, not a single mirror/ATS. */
  minimumDistinctApplicationHosts?: number;
  maximumApplicationHostShare?: number;
}

export interface SourceQualityInput {
  policy: SourceQualityPolicy;
  result: Pick<SourceFetchResult, 'sourceId' | 'listings' | 'notModified' | 'rejectedApplicationUrls'>;
  previous?: SourceCheckpoint;
}

export interface SourceQualityRowReport {
  sourceId: string;
  rowCount: number;
  openRoleCount: number;
  hostDistribution: Record<string, number>;
  rejectedUrls: Array<{ row: number; url: string; reason: string }>;
  policyFailures: string[];
}

export interface SourceQualityReport {
  generatedAt: string;
  sources: SourceQualityRowReport[];
  failures: string[];
}

const aggregatorHosts = new Set([
  'linkedin.com', 'www.linkedin.com', 'indeed.com', 'www.indeed.com', 'glassdoor.com', 'www.glassdoor.com',
  'simplify.jobs', 'www.simplify.jobs', 'handshake.com', 'www.joinhandshake.com', 'ziprecruiter.com', 'www.ziprecruiter.com'
]);

function host(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

export function applicationUrlRejection(url: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'invalid application URL'; }
  if (parsed.protocol !== 'https:') return 'application URL must use HTTPS';
  if (aggregatorHosts.has(parsed.hostname.toLowerCase())) return `aggregator-only host is not allowed (${parsed.hostname})`;
  return undefined;
}

function urlFailure(url: string, policy: SourceQualityPolicy): string | undefined {
  const baselineFailure = applicationUrlRejection(url);
  if (baselineFailure) return baselineFailure;
  const parsed = new URL(url);
  if (policy.sourceClass === 'lever') {
    const expectedPath = new RegExp(`^/${escapeRegExp(policy.leverSite ?? '')}/[^/]+/apply/?$`);
    if (parsed.hostname !== 'jobs.lever.co' || !expectedPath.test(parsed.pathname)) return `expected direct Lever URL jobs.lever.co/${policy.leverSite}/<posting>/apply`;
  }
  return undefined;
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function reportFor(input: SourceQualityInput): SourceQualityRowReport {
  const { policy, result, previous } = input;
  const rejectedUrls: SourceQualityRowReport['rejectedUrls'] = [...(result.rejectedApplicationUrls ?? [])];
  const hosts: Record<string, number> = {};
  for (const listing of result.listings) {
    const failure = urlFailure(listing.applyUrl, policy);
    const applicationHost = host(listing.applyUrl);
    if (applicationHost) hosts[applicationHost] = (hosts[applicationHost] ?? 0) + 1;
    if (failure) rejectedUrls.push({ row: listing.row, url: listing.applyUrl, reason: failure });
  }
  // Pre-publication URL rejections are expected policy enforcement and remain
  // visible in the report. A URL that survives into listings is a gate failure.
  const policyFailures = rejectedUrls.slice(result.rejectedApplicationUrls?.length ?? 0).map((rejected) => `${policy.id}: row ${rejected.row}: ${rejected.reason}`);
  if (!result.notModified && !policy.dormant && (previous?.successfulFetches ?? 0) > 0 && (previous?.lastRowCount ?? 0) > 0 && result.listings.length === 0) {
    policyFailures.push(`${policy.id}: suspicious zero-row result after ${previous?.lastRowCount} rows; investigate parser/source drift`);
  }
  if (policy.sourceClass === 'curated' && result.listings.length > 0) {
    const distribution = Object.values(hosts);
    const total = distribution.reduce((sum, count) => sum + count, 0);
    const distinctRequired = policy.minimumDistinctApplicationHosts ?? 2;
    const maxShare = policy.maximumApplicationHostShare ?? 0.85;
    if (Object.keys(hosts).length < distinctRequired) policyFailures.push(`${policy.id}: curated source has ${Object.keys(hosts).length} application host(s); requires ${distinctRequired}`);
    if (total > 0 && Math.max(...distribution) / total > maxShare) policyFailures.push(`${policy.id}: curated source application-host concentration exceeds ${Math.round(maxShare * 100)}%`);
  }
  return { sourceId: result.sourceId, rowCount: result.listings.length, openRoleCount: result.listings.filter((listing) => listing.state === 'open').length, hostDistribution: hosts, rejectedUrls, policyFailures };
}

/** Validates only publisher-bound sources. A discovery artifact must be human-approved before it reaches this API. */
export function verifySourceQuality(inputs: SourceQualityInput[], generatedAt = new Date().toISOString()): SourceQualityReport {
  const sources = inputs.map(reportFor);
  return { generatedAt, sources, failures: sources.flatMap((source) => source.policyFailures) };
}

export const sourceQualityPolicies: SourceQualityPolicy[] = [
  { id: 'vanshb03-summer-2027', sourceClass: 'curated' },
  { id: 'simplify-summer-2026', sourceClass: 'curated' },
  { id: 'zapply-2027', sourceClass: 'curated' },
  { id: 'speedyapply-2027-swe', sourceClass: 'curated' },
  { id: 'speedyapply-2027-ai', sourceClass: 'curated' },
  { id: 'northwestern-fintech-2027-quant', sourceClass: 'curated' },
  { id: 'canadian-tech-2027', sourceClass: 'curated', dormant: true },
  { id: 'lever-palantir', sourceClass: 'lever', leverSite: 'palantir' },
  { id: 'lever-plusai', sourceClass: 'lever', leverSite: 'plus-2' },
  { id: 'lever-hermeus', sourceClass: 'lever', leverSite: 'hermeus' },
  { id: 'lever-xsolla', sourceClass: 'lever', leverSite: 'xsolla' }
];

export function qualityPolicyFor(sourceId: string): SourceQualityPolicy {
  const policy = sourceQualityPolicies.find((candidate) => candidate.id === sourceId);
  // Test and one-off injected adapters still receive transport/zero-row checks.
  // Production adapters must be explicitly present in sourceQualityPolicies.
  return policy ?? { id: sourceId, sourceClass: 'curated', minimumDistinctApplicationHosts: 1, maximumApplicationHostShare: 1 };
}

/** Shared runtime guard so sources cannot silently accept a parser-zero regression. */
export function sourceQualityFailures(result: SourceFetchResult, previous: SourceCheckpoint | undefined): string[] {
  const configuredPolicy = sourceQualityPolicies.find((candidate) => candidate.id === result.sourceId);
  // Test adapters and one-off integrations are processed row-by-row by the
  // poller.  Applying the catalog-wide URL policy to those inputs here would
  // discard otherwise valid rows when a single listing is malformed.
  if (!configuredPolicy) {
    return !result.notModified && (previous?.successfulFetches ?? 0) > 0 && (previous?.lastRowCount ?? 0) > 0 && result.listings.length === 0
      ? [`${result.sourceId}: suspicious zero-row result after ${previous?.lastRowCount ?? 0} rows; investigate parser/source drift`]
      : [];
  }
  return verifySourceQuality([{ policy: configuredPolicy, result, previous }]).failures;
}
