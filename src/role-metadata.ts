import { createHash } from 'node:crypto';
import { boundedText, locationSummary, normalizeLocations } from './catalog-quality.js';
import { mergeEducationEvidence, mergeProvenance } from './identity/enrichment.js';
import type {
  ApplicationDeadline,
  Compensation,
  CompensationPeriod,
  CompensationRange,
  EducationAudience,
  EducationLevel,
  EvidenceSource,
  FieldProvenance,
  GraduationDateWindow,
  Internship,
  InternshipIdentity,
  InternshipLocation,
  MetadataConflict,
  MinimumDegree,
  ProvenancedValue,
  ReconciledRoleMetadata,
  RoleMetadataEvidence,
  RoleMetadataField,
  WorkMode,
} from './types.js';

export const ROLE_METADATA_EXTRACTION_VERSION = 1;
export const VERIFIED_PAGE_METADATA_SOURCES = ['official-json-ld', 'official-page'] as const;
const SOURCE_PRIORITY: Record<EvidenceSource, number> = {
  'official-ats': 0,
  'official-json-ld': 1,
  'official-page': 2,
  'reviewed-community': 3,
  'deterministic-inference': 4,
};

export interface RoleMetadataArtifact {
  title: string;
  text?: string;
  compensationText?: string;
  locations?: string[];
  workMode?: string;
  publishedAt?: string;
  updatedAt?: string;
  deadline?: string;
  deadlineTimezone?: string;
}

export interface ApplicationMetadataArtifact extends RoleMetadataArtifact {
  identifier?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function jsonLdTypes(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((item) => typeof item === 'string' ? [item.toLowerCase()] : []);
}

function jsonLdJobs(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) { value.forEach((item) => jsonLdJobs(item, output)); return; }
  if (!record(value)) return;
  if (jsonLdTypes(value['@type']).includes('jobposting')) output.push(value);
  if (value['@graph']) jsonLdJobs(value['@graph'], output);
}

function jsonLdIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || undefined;
  if (!record(value)) return undefined;
  const id = typeof value.value === 'string' || typeof value.value === 'number' ? String(value.value).trim() : '';
  return id || stringValue(value['@id']);
}

function postingIdentifierMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const normalizedExpected = decode(expected).trim().toLowerCase();
  const normalizedActual = decode(actual).trim().toLowerCase();
  if (normalizedActual === normalizedExpected) return true;
  try {
    const url = new URL(actual);
    return url.pathname.split('/').filter(Boolean).some((part) => decode(part).toLowerCase() === normalizedExpected)
      || [...url.searchParams.values()].some((value) => value.toLowerCase() === normalizedExpected)
      || decode(url.hash.replace(/^#/u, '')).toLowerCase() === normalizedExpected;
  } catch {
    return normalizedActual.split(/[:/#?&=]+/u).some((part) => part === normalizedExpected);
  }
}

function jsonLdLocations(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdLocations);
  if (!record(value)) return [];
  const name = stringValue(value.name);
  const address = record(value.address) ? value.address : undefined;
  const parts = address ? [address.addressLocality, address.addressRegion, address.addressCountry].map(stringValue).filter((item): item is string => Boolean(item)) : [];
  return name ? [name] : parts.length ? [parts.join(', ')] : [];
}

function jsonLdCompensation(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const currency = stringValue(value.currency) ?? 'XXX';
  const amountValue = record(value.value) ? value.value : value;
  const min = typeof amountValue.minValue === 'number' ? amountValue.minValue : typeof amountValue.value === 'number' ? amountValue.value : undefined;
  const max = typeof amountValue.maxValue === 'number' ? amountValue.maxValue : min;
  const unit = stringValue(amountValue.unitText);
  return min !== undefined && max !== undefined && unit ? `${currency} $${min}${min === max ? '' : ` - $${max}`} per ${unit}` : undefined;
}

/** Parses transient JSON-LD into bounded role artifacts; callers persist only extracted evidence. */
export function applicationMetadataArtifactsFromJsonDocuments(documents: readonly string[]): ApplicationMetadataArtifact[] {
  const rows: Record<string, unknown>[] = [];
  for (const document of documents) {
    try { jsonLdJobs(JSON.parse(document), rows); } catch { /* Malformed publisher blocks are non-fatal. */ }
  }
  return rows.flatMap((row) => {
    const title = stringValue(row.title);
    if (!title) return [];
    const remote = stringValue(row.jobLocationType);
    const locations = [...jsonLdLocations(row.jobLocation), ...(remote?.toUpperCase() === 'TELECOMMUTE' ? ['Remote'] : [])];
    return [{
      title,
      ...(jsonLdIdentifier(row.identifier) ? { identifier: jsonLdIdentifier(row.identifier) } : {}),
      ...(stringValue(row.description) ? { text: boundedText(stringValue(row.description)!.replace(/<[^>]+>/gu, ' '), 12_000) } : {}),
      ...(locations.length ? { locations } : {}),
      ...(remote ? { workMode: remote } : {}),
      ...(jsonLdCompensation(row.baseSalary) ? { compensationText: jsonLdCompensation(row.baseSalary) } : {}),
      ...(stringValue(row.datePosted) ? { publishedAt: stringValue(row.datePosted) } : {}),
      ...(stringValue(row.dateModified) ? { updatedAt: stringValue(row.dateModified) } : {}),
      ...(stringValue(row.validThrough) ? { deadline: stringValue(row.validThrough) } : {}),
    } satisfies ApplicationMetadataArtifact];
  });
}

function titleAgreement(expected: string, actual: string): boolean {
  const ignored = new Set(['intern', 'internship', 'summer', 'fall', 'winter', 'spring', 'new', 'grad', 'the', 'and', 'of', 'at', 'in']);
  const terms = (value: string) => [...new Set(value.toLowerCase().replace(/[^a-z0-9+#]+/gu, ' ').split(' ').filter((term) => term.length > 1 && !ignored.has(term)))];
  const expectedTerms = terms(expected); const actualTerms = new Set(terms(actual));
  return expectedTerms.length === 0 || expectedTerms.filter((term) => actualTerms.has(term)).length / expectedTerms.length >= 0.5;
}

export function extractVerifiedPageMetadataEvidence(input: {
  expectedTitle: string;
  expectedPostingId?: string;
  page: RoleMetadataArtifact;
  jsonLdArtifacts?: readonly ApplicationMetadataArtifact[];
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  exactPosting: boolean;
}): RoleMetadataEvidence[] {
  if (!input.exactPosting) return [];
  const expectedId = input.expectedPostingId?.toLowerCase();
  const artifacts = input.jsonLdArtifacts ?? [];
  const matching = artifacts.filter((artifact) => titleAgreement(input.expectedTitle, artifact.title)
    && (expectedId && artifact.identifier
      ? postingIdentifierMatches(expectedId, artifact.identifier)
      : artifacts.length === 1));
  const selected = matching.length === 1 ? matching[0] : !expectedId && artifacts.length === 1 && titleAgreement(input.expectedTitle, artifacts[0]!.title) ? artifacts[0] : undefined;
  const jsonLd = selected ? extractPostingMetadataEvidence({ artifact: selected, sourceClass: 'official-json-ld', sourceId: input.sourceId,
    sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true }) : [];
  const pageAgrees = titleAgreement(input.expectedTitle, `${input.page.title} ${input.page.text ?? ''}`);
  if (!pageAgrees && !selected) return [];
  const page = pageAgrees ? extractPostingMetadataEvidence({ artifact: input.page, sourceClass: 'official-page', sourceId: input.sourceId,
    sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true }) : [];
  return mergeRoleMetadataEvidence(jsonLd, page);
}

export interface ExtractRoleMetadataInput {
  artifact: RoleMetadataArtifact;
  sourceClass: EvidenceSource;
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  exactPosting: boolean;
  artifactHash?: string;
  titleOnly?: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function roleMetadataArtifactHash(artifact: RoleMetadataArtifact): string {
  return createHash('sha256').update(stable(artifact)).digest('hex');
}

function provenance(input: ExtractRoleMetadataInput, artifactHash: string, evidenceCode: string): FieldProvenance {
  return {
    source: input.sourceClass,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    evidenceCode,
    contentHash: artifactHash,
    observedAt: input.observedAt,
  };
}

function educationLevels(value: string): EducationLevel[] {
  const levels: EducationLevel[] = [];
  if (/\b(?:bs|bsc|b\.s\.|ba|b\.a\.|bachelor(?:['’]s|s)?|undergrad(?:uate)?|college student)\b/iu.test(value)) levels.push('undergraduate');
  if (/\b(?:ms|msc|m\.s\.|ma|m\.a\.|master(?:['’]s|s)?|graduate student)\b/iu.test(value)) levels.push('masters');
  if (/\bm\.?b\.?a\.?\b/iu.test(value)) levels.push('mba');
  if (/\b(?:ph\.?d\.?|doctoral?|doctorate)\b/iu.test(value)) levels.push('doctoral');
  return levels;
}

function minimumDegree(value: string): MinimumDegree | undefined {
  const required = (degree: string) => new RegExp(
    `(?:\\b${degree}(?: degree)?\\s+(?:is\\s+)?required\\b|\\bmust\\s+(?:have|hold|possess)\\s+(?:an?\\s+)?${degree}(?: degree)?\\b|\\bminimum(?: education| degree)?[^.;]{0,30}\\b${degree}\\b)`,
    'iu',
  ).test(value);
  if (required('(?:ph\\.?d\\.?|doctoral?|doctorate)')) return 'doctoral';
  if (required("master(?:['’]s|s)?")) return 'masters';
  if (required("bachelor(?:['’]s|s)?")) return 'bachelors';
  if (required("associate(?:['’]s|s)?")) return 'associates';
  if (/\bhigh school diploma\s+(?:is\s+)?required\b|\bminimum[^.;]{0,30}\bhigh school\b/iu.test(value)) return 'high-school';
  return undefined;
}

const MONTH: Record<string, string> = {
  january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03', april: '04', apr: '04',
  may: '05', june: '06', jun: '06', july: '07', jul: '07', august: '08', aug: '08', september: '09', sep: '09', sept: '09',
  october: '10', oct: '10', november: '11', nov: '11', december: '12', dec: '12',
};

function graduationWindow(value: string): GraduationDateWindow | undefined {
  const markers = [...value.matchAll(/\b(?:graduat(?:e|es|ed|ing|ion)|class of|degree completion)\b/giu)];
  if (!markers.length) return undefined;
  // Bind dates to the graduation phrase. Job pages often contain unrelated
  // posting/deadline dates elsewhere in one large HTML-derived text block.
  const context = markers.map((match) => value.slice(Math.max(0, (match.index ?? 0) - 80), (match.index ?? 0) + 280)).join(' ');
  const dates = [
    ...[...context.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(20\d{2})\b/giu)]
      .map((match) => `${match[2]}-${MONTH[match[1]!.toLowerCase()]}`),
    ...[...context.matchAll(/\b(Winter|Spring|Summer|Fall|Autumn)\s+(20\d{2})\b/giu)]
      .map((match) => `${match[2]}-${({ winter: '01', spring: '05', summer: '08', fall: '12', autumn: '12' } as const)[match[1]!.toLowerCase() as 'winter' | 'spring' | 'summer' | 'fall' | 'autumn']}`),
  ].sort();
  if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
  const years = [...context.matchAll(/\b20\d{2}\b/gu)].map((match) => match[0]).sort();
  if (years.length >= 2) return { start: `${years[0]}-01`, end: `${years[years.length - 1]}-12` };
  if (years.length === 1) return { start: `${years[0]}-01`, end: `${years[0]}-12` };
  return undefined;
}

function explicitWorkMode(value: string | undefined): Exclude<WorkMode, 'unspecified'> | undefined {
  if (!value) return undefined;
  if (/\bhybrid\b/iu.test(value)) return 'hybrid';
  if (/\b(?:remote|telecommute|work from home)\b/iu.test(value)) return 'remote';
  if (/\b(?:on[ -]?site|in[ -]?person)\b/iu.test(value)) return 'onsite';
  return undefined;
}

function amount(value: string, suffix?: string): number {
  const parsed = Number(value.replace(/,/gu, ''));
  return suffix?.toLowerCase() === 'k' ? parsed * 1_000 : parsed;
}

const CURRENCY_SYMBOL: Record<string, string> = { '€': 'EUR', '£': 'GBP' };
const NON_USD = new Set(['XXX', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CHF']);
const PERIOD = String.raw`hour|hourly|hr|day|daily|week|weekly|month|monthly|year|yearly|yr|annum|annual(?:ly)?`;
const PAY = new RegExp(String.raw`(?:(USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP|JPY|CNY|INR|CHF)\s*)?([$€£])?\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?\s*(?:(?:-|–|—|to)\s*(?:(USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP|JPY|CNY|INR|CHF)\s*)?[$€£]?\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?)?\s*(?:\/|per\s+)?(${PERIOD})(?:\b|$)`, 'giu');
const SPLIT_PERIOD_PAY = new RegExp(String.raw`(?:(USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP|JPY|CNY|INR|CHF)\s*)?([$€£])?\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?\s*(?:\/|per\s+)(${PERIOD})\s*(?:-|–|—|to)\s*(?:(USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP|JPY|CNY|INR|CHF)\s*)?[$€£]?\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?\s*(?:\/|per\s+)(${PERIOD})(?:\b|$)`, 'giu');
const USD_TEXT_PAY = new RegExp(String.raw`\b(USD)\s+(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?\s*(?:(?:-|–|—|to)\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?)?\s*(?:\/|per\s+)?(${PERIOD})(?:\b|$)`, 'giu');

function compensationPeriod(value: string): CompensationPeriod {
  if (/^(?:hour|hourly|hr)$/iu.test(value)) return 'hourly';
  if (/^(?:year|yearly|yr|annum|annual(?:ly)?)$/iu.test(value)) return 'annual';
  if (/^(?:day|daily)$/iu.test(value)) return 'daily';
  if (/^(?:week|weekly)$/iu.test(value)) return 'weekly';
  if (/^(?:month|monthly)$/iu.test(value)) return 'monthly';
  return 'other';
}

function dollarCurrency(knownLocations: readonly string[]): string {
  const usLocation = /\b(?:United States(?: of America)?|USA|U\.S\.|US|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/iu;
  return knownLocations.some((location) => usLocation.test(location)) ? 'USD' : 'XXX';
}

function applicability(segment: string, knownLocations: readonly string[]): Pick<CompensationRange, 'applicableLocations' | 'applicableEducationLevels'> {
  const locations = knownLocations.filter((location) => {
    const terms = location.toLowerCase().split(/[^a-z0-9]+/u).filter((term) => term.length > 2 && !['remote', 'united', 'states'].includes(term));
    return terms.length > 0 && terms.every((term) => segment.toLowerCase().includes(term));
  });
  const prefix = /^\s*([A-Za-z][A-Za-z .,&/-]{2,60})\s*:/u.exec(segment)?.[1]?.trim();
  const compensationLabel = prefix && /\b(?:salary|pay|compensation|wages?|earnings?|rate|range)\b/iu.test(prefix);
  if (!locations.length && prefix && !compensationLabel && !/^base$/iu.test(prefix)) locations.push(prefix);
  const levels = educationLevels(segment);
  return {
    ...(locations.length ? { applicableLocations: normalizeLocations(locations) } : {}),
    ...(levels.length ? { applicableEducationLevels: levels } : {}),
  };
}

export function extractCompensationRanges(
  value: string,
  input: { provenance: FieldProvenance; knownLocations?: readonly string[]; requirePayContext?: boolean } ,
): CompensationRange[] {
  const ranges: CompensationRange[] = [];
  const segments = value.split(/(?<=[.;\n])\s+|\s*[;\n]\s*/u).filter(Boolean);
  const append = (segment: string, raw: string, first: number, second: number, periodText: string, currency: string) => {
    if (input.requirePayContext && !/\b(?:salary|pay|compensation|base rate|market range|hourly rate|annual range|internships? (?:is|are) paid)\b/iu.test(segment)) return;
    const period = compensationPeriod(periodText);
    const minAmount = Math.min(first, second); const maxAmount = Math.max(first, second);
    const plausible = period === 'hourly' ? minAmount >= 5 && maxAmount <= 500
      : period === 'annual' ? minAmount >= 10_000 && maxAmount <= 1_000_000
        : minAmount > 0 && maxAmount <= 1_000_000;
    if (!plausible) return;
    ranges.push({ minAmount, maxAmount, currency, period, ...applicability(segment, input.knownLocations ?? []),
      sourceText: boundedText(raw, 160), provenance: [input.provenance] });
  };
  for (const segment of segments) {
    for (const match of segment.matchAll(SPLIT_PERIOD_PAY)) {
      const leftPeriod = compensationPeriod(match[5]!);
      const rightPeriod = compensationPeriod(match[9]!);
      if (leftPeriod !== rightPeriod) continue;
      const currency = match[1]?.toUpperCase() ?? match[6]?.toUpperCase()
        ?? CURRENCY_SYMBOL[match[2]!] ?? (match[2] === '$' ? dollarCurrency(input.knownLocations ?? []) : 'XXX');
      append(segment, match[0], amount(match[3]!, match[4]), amount(match[7]!, match[8]), match[5]!, currency);
    }
    for (const match of segment.matchAll(PAY)) {
      const explicit = match[1]?.toUpperCase();
      if (!explicit && !match[2]) continue;
      const symbolCurrency = CURRENCY_SYMBOL[match[2]!] ?? (match[2] === '$' ? dollarCurrency(input.knownLocations ?? []) : 'XXX');
      const trailing = match[5]?.toUpperCase();
      const nearbyPrefix = segment.slice(Math.max(0, (match.index ?? 0) - 8), match.index).toUpperCase().match(/\b[A-Z]{3}\s*$/u)?.[0]?.trim();
      const nearbySuffix = segment.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 8).toUpperCase().match(/^\s*[A-Z]{3}\b/u)?.[0]?.trim();
      const currency = explicit ?? trailing ?? nearbyPrefix ?? nearbySuffix ?? symbolCurrency;
      append(segment, match[0], amount(match[3]!, match[4]), match[6] ? amount(match[6], match[7]) : amount(match[3]!, match[4]), match[8]!, currency);
    }
    for (const match of segment.matchAll(USD_TEXT_PAY)) {
      append(segment, match[0], amount(match[2]!, match[3]), match[4] ? amount(match[4], match[5]) : amount(match[2]!, match[3]), match[6]!, 'USD');
    }
  }
  const key = (range: CompensationRange) => stable({ minAmount: range.minAmount, maxAmount: range.maxAmount, currency: range.currency,
    period: range.period, applicableLocations: range.applicableLocations, applicableEducationLevels: range.applicableEducationLevels });
  const unique = [...new Map(ranges.map((range) => [key(range), range])).values()];
  return unique.filter((candidate) => candidate.minAmount !== candidate.maxAmount || !unique.some((range) =>
    range !== candidate && range.minAmount !== range.maxAmount && range.period === candidate.period
      && stable({ locations: range.applicableLocations, education: range.applicableEducationLevels })
        === stable({ locations: candidate.applicableLocations, education: candidate.applicableEducationLevels })
      && range.sourceText.includes(candidate.sourceText)
      && (candidate.minAmount === range.minAmount || candidate.maxAmount === range.maxAmount)))
    .sort((left, right) => key(left).localeCompare(key(right)));
}

export function compensationFromRanges(ranges: readonly CompensationRange[]): Compensation {
  const supported = ranges.filter((range) => range.currency === 'USD' && ['hourly', 'annual'].includes(range.period));
  const raw = boundedText([...new Set(supported.map((range) => range.sourceText))].join(' · '), 160);
  const result: Compensation = { raw, ...(supported.length ? { ranges: supported.map((range) => ({ ...range, provenance: mergeProvenance(range.provenance) })) } : {}) };
  const global = supported.filter((range) => !range.applicableLocations?.length && !range.applicableEducationLevels?.length);
  const hourly = global.filter((range) => range.period === 'hourly');
  const annual = global.filter((range) => range.period === 'annual');
  if (hourly.length === 1) { result.minHourlyUSD = hourly[0]!.minAmount; result.maxHourlyUSD = hourly[0]!.maxAmount; }
  if (annual.length === 1) { result.minAnnualUSD = annual[0]!.minAmount; result.maxAnnualUSD = annual[0]!.maxAmount; }
  return result;
}

function isoInstant(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function deadline(value: string | undefined, timezone?: string): ApplicationDeadline | undefined {
  if (!value) return undefined;
  if (/\brolling\b/iu.test(value)) return { kind: 'rolling' };
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/u.exec(value);
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/iu.exec(value);
  const dayNamed = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(20\d{2})\b/iu.exec(value);
  const date = iso ? iso[0]
    : named ? `${named[3]}-${MONTH[named[1]!.toLowerCase()]}-${named[2]!.padStart(2, '0')}`
      : dayNamed ? `${dayNamed[3]}-${MONTH[dayNamed[2]!.toLowerCase()]}-${dayNamed[1]!.padStart(2, '0')}` : undefined;
  if (!date || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return undefined;
  const explicitZone = timezone ?? (/Z$/u.test(value.trim()) ? 'UTC' : /[+-]\d{2}:\d{2}$/u.exec(value.trim())?.[0]);
  return { kind: 'date', date, ...(explicitZone ? { timezone: explicitZone === 'UTC' ? explicitZone : `UTC${explicitZone}` } : {}) };
}

function fieldExcerpt(value: string, pattern: RegExp): string | undefined {
  const sentence = value.split(/(?<=[.!?;\n])\s+/u).find((part) => pattern.test(part));
  return sentence ? boundedText(sentence, 240) : undefined;
}

function explicitPageWorkMode(value: string): Exclude<WorkMode, 'unspecified'> | undefined {
  const labeled = /\b(?:work(?:place| location| arrangement)?|location type|work mode)\s*:\s*(remote|hybrid|on[ -]?site|in[ -]?person)\b/iu.exec(value)?.[1];
  const sentence = /\b(?:this|the)\s+(?:role|position|job)\s+is\s+(?:fully\s+)?(remote|hybrid|on[ -]?site|in[ -]?person)\b/iu.exec(value)?.[1];
  return explicitWorkMode(labeled ?? sentence);
}

function labeledLocations(value: string): string[] {
  const match = /\b(?:job\s+)?locations?\s*:\s*([^.;|\n]{2,120})/iu.exec(value)?.[1];
  if (!match || /^(?:remote|hybrid|on[ -]?site|in[ -]?person)$/iu.test(match.trim())) return [];
  return normalizeLocations([match]);
}

function labeledInstant(value: string, label: 'posted' | 'updated'): string | undefined {
  const expression = label === 'posted'
    ? /\b(?:date posted|posted(?: on)?)\s*:\s*([^.;\n]{8,50})/iu
    : /\b(?:last updated|updated(?: on)?)\s*:\s*([^.;\n]{8,50})/iu;
  const raw = expression.exec(value)?.[1];
  return isoInstant(raw);
}

/** Extracts only explicit facts from an exact role artifact. Absence produces no value. */
export function extractRoleMetadataEvidence(input: ExtractRoleMetadataInput): RoleMetadataEvidence | undefined {
  if (!input.exactPosting) return undefined;
  const artifactHash = input.artifactHash ?? roleMetadataArtifactHash(input.artifact);
  const field = (code: string) => provenance(input, artifactHash, code);
  const title = input.artifact.title.trim();
  // Title-derived audience hints intentionally live in their own low-priority
  // evidence record. Do not let a title token inherit official-page authority.
  const text = input.titleOnly ? title : input.artifact.text ?? '';
  const compensationText = input.titleOnly ? '' : input.artifact.compensationText ?? input.artifact.text ?? '';
  const normalizedLocations = input.titleOnly ? [] : normalizeLocations(input.artifact.locations?.length ? input.artifact.locations : labeledLocations(input.artifact.text ?? ''));
  const compensationRanges = extractCompensationRanges(compensationText, {
    provenance: field('compensation-range'), knownLocations: normalizedLocations,
    requirePayContext: !input.artifact.compensationText,
  });
  const levels = educationLevels(text);
  const window = graduationWindow(text);
  const degree = minimumDegree(text);
  const education = levels.length || window || degree ? mergeEducationEvidence([{
    ...(levels.length ? { levels } : {}), ...(window ? { graduationDateWindow: window } : {}), ...(degree ? { minimumDegree: degree } : {}),
    provenance: [field(input.titleOnly ? 'education-title-explicit' : 'education-explicit')],
  }]) : undefined;
  const mode = input.titleOnly
    ? explicitWorkMode(title)
    : explicitWorkMode(input.artifact.workMode) ?? explicitPageWorkMode(input.artifact.text ?? '');
  const locations: InternshipLocation[] = normalizedLocations.map((name) => ({ name,
    workMode: explicitWorkMode(name) ?? mode ?? 'unspecified', provenance: [field('location-explicit')] }));
  const directDeadline = input.titleOnly ? undefined : deadline(input.artifact.deadline, input.artifact.deadlineTimezone);
  const textDeadline = input.titleOnly ? undefined : deadline(fieldExcerpt(input.artifact.text ?? '', /\b(?:application )?(?:deadline|closes?|apply by)\b/iu));
  const applicationDeadline = directDeadline ?? textDeadline;
  const publishedAt = input.titleOnly ? undefined : isoInstant(input.artifact.publishedAt) ?? labeledInstant(input.artifact.text ?? '', 'posted');
  const updatedAt = input.titleOnly ? undefined : isoInstant(input.artifact.updatedAt) ?? labeledInstant(input.artifact.text ?? '', 'updated');
  if (!compensationRanges.length && !education && !locations.length && !mode && !applicationDeadline && !publishedAt && !updatedAt) return undefined;
  const excerpts: Partial<Record<RoleMetadataField, string>> = {};
  if (compensationRanges.length) excerpts.compensation = boundedText([...new Set(compensationRanges.map((range) => range.sourceText))].join(' · '), 240);
  if (education) excerpts.education = fieldExcerpt(text, /\b(?:bachelor|undergrad|master|graduate student|mba|ph\.?d\.?|doctoral?|graduat(?:e|ing|ion)|class of)\b/iu);
  if (applicationDeadline) excerpts['application-deadline'] = fieldExcerpt(input.artifact.text ?? input.artifact.deadline ?? '', /\b(?:deadline|closes?|apply by|rolling)\b/iu);
  return {
    schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash,
    sourceClass: input.sourceClass, sourceId: input.sourceId, sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true,
    ...(compensationRanges.length ? { compensationRanges } : {}), ...(education ? { education } : {}), ...(locations.length ? { locations } : {}),
    ...(mode ? { workMode: { value: mode, provenance: [field(input.titleOnly ? 'work-mode-title-explicit' : 'work-mode-explicit')] } } : {}),
    ...(applicationDeadline ? { applicationDeadline: { value: applicationDeadline, provenance: [field('application-deadline-explicit')] } } : {}),
    ...(publishedAt ? { employerPublishedAt: { value: publishedAt, provenance: [field('employer-published-at')] } } : {}),
    ...(updatedAt ? { employerUpdatedAt: { value: updatedAt, provenance: [field('employer-updated-at')] } } : {}),
    ...(Object.keys(excerpts).length ? { excerpts } : {}),
  };
}

export function extractPostingMetadataEvidence(input: Omit<ExtractRoleMetadataInput, 'sourceClass' | 'titleOnly'> & { sourceClass: Exclude<EvidenceSource, 'deterministic-inference'> }): RoleMetadataEvidence[] {
  const artifactHash = input.artifactHash ?? roleMetadataArtifactHash(input.artifact);
  const extracted = extractRoleMetadataEvidence({ ...input, artifactHash });
  const sourceSnapshot: RoleMetadataEvidence = extracted ?? {
    schemaVersion: 1,
    extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
    artifactHash,
    sourceClass: input.sourceClass,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    exactPosting: true,
  };
  return [
    sourceSnapshot,
    extractRoleMetadataEvidence({ ...input, artifactHash, sourceClass: 'deterministic-inference', titleOnly: true }),
  ].filter((value): value is RoleMetadataEvidence => Boolean(value));
}

export function roleMetadataEvidenceHasFields(value: RoleMetadataEvidence): boolean {
  return Boolean(value.compensationRanges?.length || value.education || value.locations?.length || value.workMode
    || value.applicationDeadline || value.employerPublishedAt || value.employerUpdatedAt);
}

export function metadataEvidenceSlot(value: RoleMetadataEvidence): string {
  return `${value.sourceClass}\0${value.sourceId}`;
}

export function mergeRoleMetadataEvidence(current: readonly RoleMetadataEvidence[] = [], incoming: readonly RoleMetadataEvidence[] = []): RoleMetadataEvidence[] {
  const slots = new Map(current.map((item) => [metadataEvidenceSlot(item), item]));
  for (const item of incoming) slots.set(metadataEvidenceSlot(item), item);
  return [...slots.values()].sort((left, right) => metadataEvidenceSlot(left).localeCompare(metadataEvidenceSlot(right)));
}

/** Replaces the complete page-derived snapshot while preserving evidence owned by other stages. */
export function replaceVerifiedPageMetadataEvidence(
  current: readonly RoleMetadataEvidence[] = [],
  incoming: readonly RoleMetadataEvidence[] = [],
  sourceId: string,
): RoleMetadataEvidence[] {
  const replaced = new Set<EvidenceSource>(VERIFIED_PAGE_METADATA_SOURCES);
  return mergeRoleMetadataEvidence(
    current.filter((item) => item.sourceId !== sourceId || !replaced.has(item.sourceClass)),
    incoming,
  );
}

function priority(value: { provenance: FieldProvenance[] }): number {
  return Math.min(...value.provenance.map((item) => SOURCE_PRIORITY[item.source]));
}

function scalar<T>(field: RoleMetadataField, values: Array<ProvenancedValue<T> & { artifactHash: string }>, existing?: T): {
  value?: ProvenancedValue<T>; conflict?: MetadataConflict;
} {
  if (!values.length) return {};
  const best = Math.min(...values.map(priority));
  const candidates = values.filter((value) => priority(value) === best);
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = stable(candidate.value); const matches = groups.get(key) ?? []; matches.push(candidate); groups.set(key, matches);
  }
  if (groups.size > 1) return {
    ...(existing !== undefined ? { value: { value: existing, provenance: [] } } : {}),
    conflict: { field, evidenceHashes: [...new Set(candidates.map((item) => item.artifactHash))].sort(), values: [...groups.keys()].sort() },
  };
  const matching = [...groups.values()][0]!;
  return { value: { value: matching[0]!.value, provenance: mergeProvenance(matching.flatMap((item) => item.provenance)) } };
}

function rangeApplicability(range: CompensationRange): string {
  return stable({ currency: range.currency, period: range.period,
    locations: [...(range.applicableLocations ?? [])].map((item) => item.toLowerCase()).sort(),
    education: [...(range.applicableEducationLevels ?? [])].sort() });
}

function rangeValue(range: CompensationRange): string {
  return stable({ minAmount: range.minAmount, maxAmount: range.maxAmount });
}

function reconcileRanges(evidence: readonly RoleMetadataEvidence[], existing: readonly CompensationRange[] = []): { ranges: CompensationRange[]; conflicts: MetadataConflict[] } {
  const groups = new Map<string, Array<CompensationRange & { artifactHash: string }>>();
  for (const item of evidence) for (const range of item.compensationRanges ?? []) {
    if (range.currency !== 'USD' || !['hourly', 'annual'].includes(range.period)) continue;
    const key = rangeApplicability(range); const values = groups.get(key) ?? []; values.push({ ...range, artifactHash: item.artifactHash }); groups.set(key, values);
  }
  const ranges: CompensationRange[] = []; const conflicts: MetadataConflict[] = [];
  for (const [key, values] of groups) {
    const best = Math.min(...values.map(priority));
    const candidates = values.filter((value) => priority(value) === best);
    const distinct = new Map(candidates.map((value) => [rangeValue(value), value]));
    if (distinct.size > 1) {
      const preserved = existing.find((range) => rangeApplicability(range) === key);
      if (preserved) ranges.push(preserved);
      conflicts.push({ field: 'compensation', applicabilityKey: key,
        evidenceHashes: [...new Set(candidates.map((item) => item.artifactHash))].sort(), values: [...distinct.keys()].sort() });
      continue;
    }
    const winner = [...distinct.values()][0]!;
    ranges.push({ minAmount: winner.minAmount, maxAmount: winner.maxAmount, currency: winner.currency, period: winner.period,
      ...(winner.applicableLocations?.length ? { applicableLocations: winner.applicableLocations } : {}),
      ...(winner.applicableEducationLevels?.length ? { applicableEducationLevels: winner.applicableEducationLevels } : {}),
      sourceText: winner.sourceText, provenance: mergeProvenance(candidates.flatMap((item) => item.provenance)) });
  }
  return { ranges: ranges.sort((left, right) => rangeApplicability(left).localeCompare(rangeApplicability(right))), conflicts };
}

export function reconcileRoleMetadata(
  evidence: readonly RoleMetadataEvidence[],
  existing?: Internship,
): { metadata?: ReconciledRoleMetadata; compensation?: Compensation; conflicts: MetadataConflict[] } {
  const usable = evidence.filter((item) => item.schemaVersion === 1 && item.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION
    && item.exactPosting && roleMetadataEvidenceHasFields(item));
  if (!usable.length) return { conflicts: [] };
  const conflicts: MetadataConflict[] = [];
  const ranges = reconcileRanges(usable, existing?.compensation.ranges);
  conflicts.push(...ranges.conflicts);
  const bestEducation = usable.filter((item) => item.education).map((item) => ({ ...item.education!, artifactHash: item.artifactHash }));
  let education: EducationAudience | undefined;
  if (bestEducation.length) {
    const best = Math.min(...bestEducation.map(priority));
    education = mergeEducationEvidence(bestEducation.filter((item) => priority(item) === best));
    if (education.evidenceStatus === 'conflicting') {
      conflicts.push({ field: 'education', evidenceHashes: [...new Set(bestEducation.map((item) => item.artifactHash))].sort(), values: bestEducation.map((item) => stable(item)).sort() });
      education = undefined;
    }
  }
  const locationValues = usable.flatMap((item) => (item.locations ?? []).map((location) => ({ ...location, artifactHash: item.artifactHash })));
  let locations: InternshipLocation[] | undefined;
  if (locationValues.length) {
    const best = Math.min(...locationValues.map(priority));
    const selected = locationValues.filter((item) => priority(item) === best);
    const byName = new Map<string, typeof selected>();
    for (const location of selected) { const key = location.name.toLowerCase(); const values = byName.get(key) ?? []; values.push(location); byName.set(key, values); }
    locations = [...byName.entries()].flatMap(([key, values]) => {
      const modes = [...new Set(values.map((item) => item.workMode).filter((item) => item !== 'unspecified'))].sort();
      if (modes.length > 1) {
        conflicts.push({ field: 'work-mode', applicabilityKey: key,
          evidenceHashes: [...new Set(values.map((item) => item.artifactHash))].sort(), values: modes });
        const preserved = existing?.roleMetadata?.locations?.find((item) => item.name.toLowerCase() === key);
        return preserved ? [preserved] : [];
      }
      return [{ name: values[0]!.name, workMode: modes[0] ?? 'unspecified',
        provenance: mergeProvenance(values.flatMap((item) => item.provenance)) }];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
  const scalarValues = <T>(pick: (item: RoleMetadataEvidence) => ProvenancedValue<T> | undefined) => usable.flatMap((item) => {
    const value = pick(item); return value ? [{ ...value, artifactHash: item.artifactHash }] : [];
  });
  const workMode = scalar('work-mode', scalarValues((item) => item.workMode), existing?.workMode === 'unspecified' ? undefined : existing?.workMode as Exclude<WorkMode, 'unspecified'> | undefined);
  const applicationDeadline = scalar('application-deadline', scalarValues((item) => item.applicationDeadline), existing?.applicationDeadline);
  const employerPublishedAt = scalar('employer-published-at', scalarValues((item) => item.employerPublishedAt), existing?.employerPublishedAt);
  const employerUpdatedAt = scalar('employer-updated-at', scalarValues((item) => item.employerUpdatedAt), existing?.employerUpdatedAt);
  for (const result of [workMode, applicationDeadline, employerPublishedAt, employerUpdatedAt]) if (result.conflict) conflicts.push(result.conflict);
  const graduation = education?.graduationDateWindow
    ? { value: education.graduationDateWindow, provenance: education.provenance }
    : undefined;
  const metadata: ReconciledRoleMetadata = {
    schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
    evidenceHashes: [...new Set(usable.map((item) => item.artifactHash))].sort(),
    ...(ranges.ranges.length ? { compensationRanges: ranges.ranges } : {}), ...(education ? { education } : {}),
    ...(locations?.length ? { locations } : {}), ...(workMode.value?.provenance.length ? { workMode: workMode.value } : {}),
    ...(applicationDeadline.value?.provenance.length ? { applicationDeadline: applicationDeadline.value } : {}),
    ...(graduation ? { graduationWindow: graduation } : {}),
    ...(employerPublishedAt.value?.provenance.length ? { employerPublishedAt: employerPublishedAt.value } : {}),
    ...(employerUpdatedAt.value?.provenance.length ? { employerUpdatedAt: employerUpdatedAt.value } : {}),
  };
  return { metadata, ...(ranges.ranges.length ? { compensation: compensationFromRanges(ranges.ranges) } : {}), conflicts };
}

function structuredIdentity(job: Internship): InternshipIdentity | undefined {
  const identity = job.internshipIdentity;
  if (!identity || typeof identity !== 'object') return undefined;
  const value = identity as Partial<InternshipIdentity>;
  return value.company && value.programType && value.season && value.education && value.title && Array.isArray(value.locations)
    ? value as InternshipIdentity : undefined;
}

/** Projects reconciled evidence without touching identity, lifecycle, visibility, or notification state. */
export function projectRoleMetadata(job: Internship, evidence = job.sourceReferences.flatMap((item) => item.metadataEvidence ?? [])): {
  job: Internship; conflicts: MetadataConflict[];
} {
  const result = reconcileRoleMetadata(evidence, job);
  const identity = structuredIdentity(job);
  const previousMetadata = job.roleMetadata;
  // A conflict is not a withdrawal. Retain the accepted projection and its
  // provenance so later resolution or withdrawal can still replace it cleanly.
  if (result.metadata && previousMetadata) {
    const conflicted = new Set(result.conflicts.map((conflict) => conflict.field));
    const preserve = <K extends keyof ReconciledRoleMetadata>(key: K, field: RoleMetadataField) => {
      if (conflicted.has(field) && result.metadata![key] === undefined && previousMetadata[key] !== undefined) {
        result.metadata![key] = previousMetadata[key];
      }
    };
    preserve('workMode', 'work-mode');
    preserve('applicationDeadline', 'application-deadline');
    preserve('employerPublishedAt', 'employer-published-at');
    preserve('employerUpdatedAt', 'employer-updated-at');
  }
  if (!result.metadata && !identity?.programType?.value && !previousMetadata) return { job, conflicts: result.conflicts };
  const metadataLocations = result.metadata?.locations;
  const locationNames = metadataLocations?.map((item) => item.name);
  const previousEducationWasProjected = Boolean(identity && previousMetadata?.education
    && stable(identity.education) === stable(previousMetadata.education));
  const previousIdentityLocationsWereProjected = Boolean(identity && previousMetadata?.locations
    && stable(identity.locations) === stable(previousMetadata.locations));
  const updatedIdentity = identity && (result.metadata || previousMetadata) ? {
    ...identity,
    ...(result.metadata?.education ? { education: result.metadata.education }
      : previousEducationWasProjected ? { education: { levels: [], evidenceStatus: 'unspecified' as const, provenance: [] } } : {}),
    ...(metadataLocations?.length ? { locations: metadataLocations } : previousIdentityLocationsWereProjected ? { locations: [] } : {}),
  } : job.internshipIdentity;
  const previousCompensationWasProjected = Boolean(previousMetadata?.compensationRanges
    && stable(job.compensation) === stable(compensationFromRanges(previousMetadata.compensationRanges)));
  const projected: Internship = {
    ...job,
    ...(updatedIdentity ? { internshipIdentity: updatedIdentity } : {}),
    ...(result.metadata ? { roleMetadata: result.metadata } : {}),
    ...(result.compensation ? { compensation: result.compensation } : previousCompensationWasProjected ? { compensation: { raw: '' } } : {}),
    ...(locationNames?.length ? { locations: locationNames, location: locationSummary(locationNames) } : {}),
    ...(result.metadata?.workMode ? { workMode: result.metadata.workMode.value } : {}),
    ...(result.metadata?.applicationDeadline ? { applicationDeadline: result.metadata.applicationDeadline.value } : {}),
    ...(result.metadata?.graduationWindow ? { graduationWindow: result.metadata.graduationWindow.value } : {}),
    ...(identity?.programType?.value ? { programType: identity.programType.value } : {}),
    ...(result.metadata?.employerPublishedAt ? { employerPublishedAt: result.metadata.employerPublishedAt.value } : {}),
    ...(result.metadata?.employerUpdatedAt ? { employerUpdatedAt: result.metadata.employerUpdatedAt.value } : {}),
  };
  if (!result.metadata) delete projected.roleMetadata;
  if (previousMetadata?.workMode?.value === job.workMode && !result.metadata?.workMode) delete projected.workMode;
  if (stable(previousMetadata?.applicationDeadline?.value) === stable(job.applicationDeadline) && !result.metadata?.applicationDeadline) delete projected.applicationDeadline;
  if (stable(previousMetadata?.graduationWindow?.value) === stable(job.graduationWindow) && !result.metadata?.graduationWindow) delete projected.graduationWindow;
  if (previousMetadata?.employerPublishedAt?.value === job.employerPublishedAt && !result.metadata?.employerPublishedAt) delete projected.employerPublishedAt;
  if (previousMetadata?.employerUpdatedAt?.value === job.employerUpdatedAt && !result.metadata?.employerUpdatedAt) delete projected.employerUpdatedAt;
  const previousLocationNames = previousMetadata?.locations?.map((item) => item.name);
  if (previousLocationNames && stable(previousLocationNames) === stable(job.locations) && !metadataLocations?.length) {
    const fallbackLocations = normalizeLocations(job.sourceReferences.flatMap((reference) => reference.locations ?? [reference.location]));
    if (fallbackLocations.length) {
      projected.locations = fallbackLocations;
      projected.location = locationSummary(fallbackLocations);
    } else {
      delete projected.locations;
      projected.location = 'Location not specified';
    }
  }
  return { job: projected, conflicts: result.conflicts };
}

export function unsupportedMetadataCurrencies(evidence: readonly RoleMetadataEvidence[]): string[] {
  return [...new Set(evidence.flatMap((item) => item.compensationRanges ?? []).map((range) => range.currency).filter((currency) => NON_USD.has(currency)))].sort();
}

export function unsupportedMetadataPeriods(evidence: readonly RoleMetadataEvidence[]): string[] {
  return [...new Set(evidence.flatMap((item) => item.compensationRanges ?? []).map((range) => range.period)
    .filter((period) => !['hourly', 'annual'].includes(period)))].sort();
}
