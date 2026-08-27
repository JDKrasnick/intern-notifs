import { normalizeCompanyDomain } from './domain.js';
import { safeFetchText, type HostResolver, type SafeFetchOptions } from './safe-network.js';

export interface TxtResolver {
  resolveTxt(hostname: string): Promise<readonly (string | readonly string[])[]>;
}

export type ChallengeVerificationMethod = 'dns-txt' | 'https-well-known';

export interface ChallengeVerificationResult {
  verified: boolean;
  method: ChallengeVerificationMethod;
  location: string;
}

export async function verifyDnsChallenge(input: {
  domain: string;
  token: string;
  resolver: TxtResolver;
}): Promise<ChallengeVerificationResult> {
  if (!input.token) throw new Error('Challenge token is required');
  const domain = normalizeCompanyDomain(input.domain);
  if (!domain) throw new Error('Company domain is invalid');
  const location = `_internnotifs-verification.${domain}`;
  const records = await input.resolver.resolveTxt(location);
  const values = records.map((record) => (typeof record === 'string' ? record : record.join('')).trim());
  return { verified: values.includes(input.token), method: 'dns-txt', location };
}

export async function verifyWellKnownChallenge(input: {
  domain: string;
  token: string;
  resolver: HostResolver;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
}): Promise<ChallengeVerificationResult> {
  if (!input.token) throw new Error('Challenge token is required');
  const domain = normalizeCompanyDomain(input.domain);
  if (!domain) throw new Error('Company domain is invalid');
  const location = `https://${domain}/.well-known/internnotifs-verification.txt`;
  const fetchOptions: SafeFetchOptions = {
    resolver: input.resolver,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.maxRedirects === undefined ? {} : { maxRedirects: input.maxRedirects }),
    ...(input.maxBodyBytes === undefined ? {} : { maxBodyBytes: input.maxBodyBytes }),
  };
  const response = await safeFetchText(location, fetchOptions);
  // A domain-control proof must not escape to another host through a redirect.
  const finalUrl = new URL(response.url);
  const verified = response.status >= 200 && response.status < 300
    && finalUrl.hostname.toLowerCase() === domain
    && response.body.trim() === input.token;
  return { verified, method: 'https-well-known', location };
}
