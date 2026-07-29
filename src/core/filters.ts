import type { RawListing } from '../types.js';
import { employerCategories, employerCategory, type EmployerCategory } from './employers.js';

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
  /** When supplied, a job must match one selected company bucket as well as any role or keyword filter. */
  includeEmployerCategories?: EmployerCategory[];
  /** Exclusions always win over employer-category inclusions. */
  excludeEmployerCategories?: EmployerCategory[];
  /** Hide listings whose source explicitly requires U.S. citizenship. */
  excludeUsCitizenshipRequired?: boolean;
  /** Hide listings whose source explicitly marks an advanced degree as required. */
  excludeAdvancedDegreeRequired?: boolean;
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

/**
 * Technical evidence the six coarse categories miss. Category patterns drive
 * user-facing filters, so they stay as they are; eligibility additionally
 * accepts a named technical domain.
 *
 * All three patterns match the role title and its classification context only,
 * never the company: "Palantir Technologies" must not make its marketing roles
 * technical.
 *
 * `strong` names a domain no other function shares, so it settles eligibility on
 * its own.
 */
const strongTechnicalPattern = new RegExp([
  String.raw`\b(?:software|swe|sde+|firmware|hardware|embedded|silicon|semiconductor|fpga|asic|vlsi|rtl|pcb)\b`,
  String.raw`\b(?:programming|programmer|developer|coding|compiler|algorithms?|computational|bioinformatics)\b`,
  String.raw`\b(?:computer (?:science|engineer(?:ing)?|vision)|(?:applied|research|data|computer) scientist)\b`,
  String.raw`\b(?:infrastructure|devops|\bsre\b|site reliability|kubernetes|observability|\biot\b|robotics|mechatronics)\b`,
  String.raw`\b(?:cloud|databases?|\bsql\b|nosql|distributed systems?|windows|linux|unix|macos)\b`,
  String.raw`\b(?:cyber ?security|infosec|appsec|cryptograph\w*|penetration test\w*)\b`,
  String.raw`\b(?:machine learning|deep learning|gen(?:erative)? ?ai|artificial intelligence|\bml\b|\bnlp\b|\bllm\b|inference)\b`,
  String.raw`\bdata (?:engineer\w*|analyst\w*|analytics|scien\w+|pipeline|platform|integration|extraction|warehouse|modeling)\b`,
  String.raw`\b(?:sdet|test automation|quality (?:assurance|engineer(?:ing)?)|technical staff)\b`,
  String.raw`\b(?:ios|android|front ?end|back ?end|full ?stack)\b`,
  // Quantitative finance is in scope, and its titles often also say "sales".
  String.raw`\b(?:quant|quantitative|trading|trader|algorithmic)\b`,
].join('|'), 'i');

/** Acronyms whose lowercase forms are ordinary English words, so case matters. */
const technicalAcronymPattern = /\b(?:IT|QA|BI|ETL|DBA)\b/;

/**
 * `qualified` evidence is technical only alongside a technical role word:
 * "Platform Engineer" is, "Platform Campaign" is not.
 */
const qualifiedTechnicalPattern = new RegExp([
  String.raw`\b(?:platform|systems?|network\w*|security|technolog\w+|analytics|business intelligence|\bqa\b|mobile|web)\b[^,|(]{0,24}\b(?:engineer\w*|developer|architect\w*|analyst\w*|administrator|administration|operations?|intern(?:ship)?s?|co-?op)\b`,
  String.raw`\b(?:engineer\w*|analyst\w*|intern(?:ship)?s?|co-?op)\b[^,|(]{0,24}\b(?:platform|systems?|network\w*|security|technolog\w+|analytics|business intelligence)\b`,
].join('|'), 'i');

/**
 * A business function outranks evidence it merely shares a word with: "Talent
 * Acquisition Technology Intern" recruits and "Platform Campaign Intern"
 * markets, while a strong signal such as "Data Science Intern (Customer
 * Success)" still stands.
 */
const nontechnicalFunctionPattern = new RegExp([
  String.raw`\b(?:talent acquisition|recruit\w*|people operations|human resources|\bhr\b)\b`,
  String.raw`\b(?:marketing|campaign|brand|advertis\w*|social media|public relations|communications?)\b`,
  String.raw`\b(?:sales|account executive|business development|partnerships?|customer (?:success|advocacy|service|experience))\b`,
  String.raw`\b(?:supply chain|logistics|procurement|purchasing|warehouse operations|facilities|real estate)\b`,
  String.raw`\b(?:legal|paralegal|compliance officer|accounting|payroll|\btax\b|audit(?:or|ing)?)\b`,
  String.raw`\b(?:event|concierge|hospitality|volunteer|fundrais\w*|philanthrop\w*)\b`,
].join('|'), 'i');

function terms(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>) {
  return `${listing.company} ${listing.title} ${listing.location} ${listing.season}`.replace(/\s+/g, ' ').trim();
}
function matchesKeyword(value: string, keyword: string) { return keyword.trim() !== '' && value.toLowerCase().includes(keyword.trim().toLowerCase()); }
function matchesCategory(value: string, category: JobCategory) { return patterns[category].test(value); }

export function classifyJob(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>): JobCategory[] {
  const value = terms(listing);
  return jobCategories.filter((category) => matchesCategory(value, category));
}
/**
 * Eligibility reads the role, never the employer or its city: not every job at
 * "Jump Trading Group" is quantitative, and not every job in "Research Triangle
 * Park" is research. User-facing keyword filters still match the whole listing.
 */
export function isTechnicalJob(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>) {
  if (strongTechnicalPattern.test(listing.title) || technicalAcronymPattern.test(listing.title)) return true;
  if (nontechnicalFunctionPattern.test(listing.title)) return false;
  const role = { company: '', title: listing.title, location: '', season: '' };
  return classifyJob(role).some((category) => technicalJobCategories.includes(category))
    || qualifiedTechnicalPattern.test(listing.title);
}

/** Deterministic title-keyword classification for compact notification context; it does not infer qualifications. */
export function inferJobFocuses(listing: Pick<RawListing, 'title'>): JobFocus[] {
  const value = listing.title.replace(/\s+/g, ' ').trim();
  const matched = focusPatterns.filter(([, pattern]) => pattern.test(value)).map(([focus]) => focus);
  return matched.length ? matched : /\b(software|swe|engineer|developer)\b/i.test(value) ? ['SWE'] : [];
}

export function matchesJobFilter(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season' | 'requirements'>, filter?: JobFilter) {
  if (!filter) return true;
  const value = terms(listing);
  const categories = classifyJob(listing);
  const companyCategory = employerCategory(listing.company);
  const requirements = listing.requirements ?? {
    requiresUsCitizenship: /🇺🇸|\b(?:requires?|must be)\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(value),
    advancedDegreeRequired: /🎓|\b(?:advanced degree|master'?s|ph\.?d\.?|mba)\b/i.test(value)
  };
  const excluded = [...(filter.excludeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(filter.excludeCategories ?? []).map((category) => categories.includes(category)), ...(filter.excludeEmployerCategories ?? []).map((category) => companyCategory === category), Boolean(filter.excludeUsCitizenshipRequired && requirements.requiresUsCitizenship), Boolean(filter.excludeAdvancedDegreeRequired && requirements.advancedDegreeRequired)].some(Boolean);
  if (excluded) return false;
  const roleInclusions = [...(filter.includeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(filter.includeCategories ?? []).map((category) => categories.includes(category))];
  const employerInclusions = (filter.includeEmployerCategories ?? []).map((category) => companyCategory === category);
  return (roleInclusions.length === 0 || roleInclusions.some(Boolean)) && (employerInclusions.length === 0 || employerInclusions.some(Boolean));
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
function employerCategoryList(value: unknown, name: string): EmployerCategory[] | undefined {
  const values = stringList(value, name);
  if (values?.some((value) => !employerCategories.includes(value as EmployerCategory))) throw new Error(`jobFilter.${name} contains an unsupported employer category`);
  return values as EmployerCategory[] | undefined;
}
function booleanValue(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`jobFilter.${name} must be a boolean`);
  return value;
}

export function parseJobFilter(value: unknown): JobFilter | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('jobFilter must be an object');
  const config = value as Record<string, unknown>;
  const includeKeywords = stringList(config.includeKeywords, 'includeKeywords');
  const includeCategories = categoryList(config.includeCategories, 'includeCategories');
  const excludeKeywords = stringList(config.excludeKeywords, 'excludeKeywords');
  const excludeCategories = categoryList(config.excludeCategories, 'excludeCategories');
  const includeEmployerCategories = employerCategoryList(config.includeEmployerCategories, 'includeEmployerCategories');
  const excludeEmployerCategories = employerCategoryList(config.excludeEmployerCategories, 'excludeEmployerCategories');
  const excludeUsCitizenshipRequired = booleanValue(config.excludeUsCitizenshipRequired, 'excludeUsCitizenshipRequired');
  const excludeAdvancedDegreeRequired = booleanValue(config.excludeAdvancedDegreeRequired, 'excludeAdvancedDegreeRequired');
  return {
    ...(includeKeywords !== undefined ? { includeKeywords } : {}),
    ...(includeCategories !== undefined ? { includeCategories } : {}),
    ...(excludeKeywords !== undefined ? { excludeKeywords } : {}),
    ...(excludeCategories !== undefined ? { excludeCategories } : {}),
    ...(includeEmployerCategories !== undefined ? { includeEmployerCategories } : {}),
    ...(excludeEmployerCategories !== undefined ? { excludeEmployerCategories } : {}),
    ...(excludeUsCitizenshipRequired !== undefined ? { excludeUsCitizenshipRequired } : {}),
    ...(excludeAdvancedDegreeRequired !== undefined ? { excludeAdvancedDegreeRequired } : {})
  };
}
