import type { RawListing } from '../types.js';

export const jobCategories = ['ai-ml', 'grad', 'swe', 'quant', 'product', 'design'] as const;
export type JobCategory = typeof jobCategories[number];
export interface JobFilter {
  /** A job must match at least one included keyword or category when either list is supplied. */
  includeKeywords?: string[];
  includeCategories?: JobCategory[];
  /** Exclusions always win over inclusions. */
  excludeKeywords?: string[];
  excludeCategories?: JobCategory[];
}

const patterns: Record<JobCategory, RegExp> = {
  'ai-ml': /\b(ai|artificial intelligence|machine learning|ml|data scien(?:ce|tist)|deep learning|nlp|computer vision|generative ai|llm)\b/i,
  grad: /\b(graduate|grad|master'?s|ph\.?d\.?|mba)\b/i,
  swe: /\b(software|swe|backend|frontend|full[ -]?stack|developer|engineering)\b/i,
  quant: /\b(quant|quantitative|trading|trader|research)\b/i,
  product: /\b(product manager|product management|pm)\b/i,
  design: /\b(design|ux|ui|user experience)\b/i
};

function terms(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>) {
  return `${listing.company} ${listing.title} ${listing.location} ${listing.season}`.replace(/\s+/g, ' ').trim();
}
function matchesKeyword(value: string, keyword: string) { return keyword.trim() !== '' && value.toLowerCase().includes(keyword.trim().toLowerCase()); }
function matchesCategory(value: string, category: JobCategory) { return patterns[category].test(value); }

export function matchesJobFilter(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>, filter?: JobFilter) {
  if (!filter) return true;
  const value = terms(listing);
  const excluded = [...(filter.excludeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(filter.excludeCategories ?? []).map((category) => matchesCategory(value, category))].some(Boolean);
  if (excluded) return false;
  const inclusions = [...(filter.includeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(filter.includeCategories ?? []).map((category) => matchesCategory(value, category))];
  return inclusions.length === 0 || inclusions.some(Boolean);
}

function stringList(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) throw new Error(`jobFilter.${name} must be an array of non-empty strings`);
  return value;
}
function categoryList(value: unknown, name: string): JobCategory[] | undefined {
  const values = stringList(value, name);
  if (values?.some((value) => !jobCategories.includes(value as JobCategory))) throw new Error(`jobFilter.${name} contains an unsupported category`);
  return values as JobCategory[] | undefined;
}

export function parseJobFilter(value: unknown): JobFilter | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('jobFilter must be an object');
  const config = value as Record<string, unknown>;
  return {
    includeKeywords: stringList(config.includeKeywords, 'includeKeywords'),
    includeCategories: categoryList(config.includeCategories, 'includeCategories'),
    excludeKeywords: stringList(config.excludeKeywords, 'excludeKeywords'),
    excludeCategories: categoryList(config.excludeCategories, 'excludeCategories')
  };
}
