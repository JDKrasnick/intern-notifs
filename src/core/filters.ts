import type { RawListing } from '../types.js';

export const jobCategories = ['ai-ml', 'grad', 'swe', 'quant', 'product', 'design'] as const;
export type JobCategory = typeof jobCategories[number];
/** The initial public catalog deliberately stays focused on technical early-career roles. */
export const technicalJobCategories: JobCategory[] = ['ai-ml', 'swe', 'quant', 'product', 'design'];
export const jobFocuses = ['AI/ML', 'Cloud/Infra', 'Security', 'Data', 'Backend/API', 'Frontend/Mobile', 'Systems/Hardware', 'Quant/Fintech', 'Product', 'Design', 'SWE'] as const;
export type JobFocus = typeof jobFocuses[number];
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
const focusPatterns: Array<[JobFocus, RegExp]> = [
  ['AI/ML', /\b(generative ai|gen ai|artificial intelligence|machine learning|\bml\b|llm|nlp|natural language|computer vision|deep learning)\b/i],
  ['Cloud/Infra', /\b(cloud|infrastructure|infra|platform|devops|site reliability|\bsre\b|distributed systems?|kubernetes|docker|networking|observability)\b/i],
  ['Security', /\b(security|cybersecurity|privacy|cryptograph|identity|authentication|authorization)\b/i],
  ['Data', /\b(data engineering|data engineer|analytics|business intelligence|\bbi\b|data warehouse|\betl\b)\b/i],
  ['Backend/API', /\b(back[- ]?end|api|microservices?|server[- ]?side|services?)\b/i],
  ['Frontend/Mobile', /\b(front[- ]?end|full[- ]?stack|web|ios|android|mobile|react)\b/i],
  ['Systems/Hardware', /\b(systems?|embedded|firmware|compiler|operating systems?|\bos\b|hardware)\b/i],
  ['Quant/Fintech', /\b(quant|quantitative|trading|trader|financial|fintech|risk)\b/i],
  ['Product', /\b(product manager|product management|\bpm\b)\b/i],
  ['Design', /\b(design|ux|ui|user experience)\b/i]
];

function terms(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>) {
  return `${listing.company} ${listing.title} ${listing.location} ${listing.season}`.replace(/\s+/g, ' ').trim();
}
function matchesKeyword(value: string, keyword: string) { return keyword.trim() !== '' && value.toLowerCase().includes(keyword.trim().toLowerCase()); }
function matchesCategory(value: string, category: JobCategory) { return patterns[category].test(value); }

export function classifyJob(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>): JobCategory[] {
  const value = terms(listing);
  return jobCategories.filter((category) => matchesCategory(value, category));
}
export function isTechnicalJob(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>) {
  return classifyJob(listing).some((category) => technicalJobCategories.includes(category));
}

/** Deterministic title-keyword classification for compact notification context; it does not infer qualifications. */
export function inferJobFocuses(listing: Pick<RawListing, 'title'>): JobFocus[] {
  const value = listing.title.replace(/\s+/g, ' ').trim();
  const matched = focusPatterns.filter(([, pattern]) => pattern.test(value)).map(([focus]) => focus);
  return matched.length ? matched : /\b(software|swe|engineer|developer)\b/i.test(value) ? ['SWE'] : [];
}

export function matchesJobFilter(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>, filter?: JobFilter) {
  if (!filter) return true;
  const value = terms(listing);
  const categories = classifyJob(listing);
  const excluded = [...(filter.excludeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(filter.excludeCategories ?? []).map((category) => categories.includes(category))].some(Boolean);
  if (excluded) return false;
  const inclusions = [...(filter.includeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(filter.includeCategories ?? []).map((category) => categories.includes(category))];
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
