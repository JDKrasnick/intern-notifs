import { createHash } from 'node:crypto';
import type { Compensation } from '../types.js';
import { companyWeight } from '../config/weights.js';

const tracking = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);
const clean = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (tracking.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

export function fingerprint(company: string, title: string, location: string, season: string): string {
  return createHash('sha256').update([company, title, location, season].map(clean).join('|')).digest('hex');
}

export function jobId(normalizedUrl: string, key: string): string {
  return createHash('sha256').update(`${normalizedUrl}|${key}`).digest('hex').slice(0, 32);
}

export function parseCompensation(raw: string): Compensation {
  const normalized = raw.replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const hourly = [...normalized.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)?\s*\$?\s*(\d+(?:\.\d+)?)?\s*(?:\/|per\s*)?(?:hr|hour)\b/gi)]
    .map((match) => Number(match[2] ?? match[1]));
  if (hourly.length) return { raw, maxHourlyUSD: Math.max(...hourly) };
  const annual = [...normalized.matchAll(/\$\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)?\s*\$?\s*(\d+(?:\.\d+)?)?\s*(?:\/|per\s*)?(?:year|yr|annum)\b/gi)]
    .map((match) => Number(match[2] ?? match[1]) / 2080);
  return annual.length ? { raw, maxHourlyUSD: Math.max(...annual) } : { raw };
}

export function score(company: string, compensation: Compensation): number {
  return companyWeight(company) + Math.min(compensation.maxHourlyUSD ?? 0, 100) / 2;
}
