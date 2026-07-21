import { createHash } from 'node:crypto';
import type { Compensation } from '../types.js';
import { companyWeight } from '../config/weights.js';

const tracking = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);
const clean = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const corporateSuffixes = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited', 'llc', 'ltd', 'plc']);

/**
 * A conservative identity key for the same role as it appears in different
 * public lists. It deliberately does not guess employer aliases (for example,
 * IBM versus International Business Machines) because a false merge is worse
 * than retaining a possible duplicate.
 */
function identityTerms(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function canonicalCompany(value: string) {
  const terms = identityTerms(value);
  while (terms.length > 1 && corporateSuffixes.has(terms.at(-1)!)) terms.pop();
  return terms.join(' ');
}
function canonicalTitle(value: string) {
  const replacements: Record<string, string[]> = { swe: ['software', 'engineer'], engineering: ['engineer'], internship: ['intern'], internships: ['intern'] };
  const terms = identityTerms(value).flatMap((term) => replacements[term] ?? [term]);
  return [...new Set(terms)].sort().join(' ');
}
function canonicalLocation(value: string) {
  const terms = identityTerms(value).join(' ');
  if (/^(nyc|new york city|new york ny)$/.test(terms)) return 'new york ny';
  if (/^remote( us| usa| united states)?$/.test(terms)) return 'remote';
  return terms;
}
function canonicalSeason(value: string) { return identityTerms(value).join(' '); }

export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (tracking.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

export function fingerprint(company: string, title: string, location: string, season: string): string {
  return createHash('sha256').update([canonicalCompany(company), canonicalTitle(title), canonicalLocation(location), canonicalSeason(season)].join('|')).digest('hex');
}

/** A migration-safe lookup order for records written before canonical role identity keys. */
export function fingerprintCandidates(company: string, title: string, location: string, season: string): string[] {
  const canonical = fingerprint(company, title, location, season);
  const legacy = createHash('sha256').update([company, title, location, season].map(clean).join('|')).digest('hex');
  return canonical === legacy ? [canonical] : [canonical, legacy];
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
