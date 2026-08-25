import type {
  EducationAudience,
  EducationLevel,
  DisciplineTag,
  EvidenceSource,
  FieldProvenance,
  GraduationDateWindow,
  MinimumDegree,
  InternshipIdentity,
  WorkMode,
  ProvenancedValue,
} from '../types.js';
import { canonicalCompanyKey } from '../core/normalize.js';

const SOURCE_PRIORITY: Record<EvidenceSource, number> = {
  'official-ats': 0,
  'official-json-ld': 1,
  'official-page': 2,
  'reviewed-community': 3,
  'deterministic-inference': 4,
};

function provenanceKey(item: FieldProvenance): string {
  return [item.source, item.sourceId, item.sourceUrl ?? '', item.evidenceCode, item.contentHash ?? ''].join('|');
}

export function mergeProvenance(items: readonly FieldProvenance[]): FieldProvenance[] {
  return [...new Map(items.map((item) => [provenanceKey(item), item])).values()]
    .sort((left, right) => SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]
      || provenanceKey(left).localeCompare(provenanceKey(right)));
}

/** Chooses the highest-authority value, retaining corroborating evidence for that value. */
export function mergeProvenancedValues<T>(values: readonly ProvenancedValue<T>[]): ProvenancedValue<T> | undefined {
  const candidates = values.filter((item) => item.provenance.length > 0);
  if (!candidates.length) return undefined;
  const priority = (item: ProvenancedValue<T>) => Math.min(...item.provenance.map((entry) => SOURCE_PRIORITY[entry.source]));
  const winner = [...candidates].sort((left, right) => priority(left) - priority(right)
    || JSON.stringify(left.value).localeCompare(JSON.stringify(right.value)))[0]!;
  const matching = candidates.filter((item) => JSON.stringify(item.value) === JSON.stringify(winner.value));
  return { value: winner.value, provenance: mergeProvenance(matching.flatMap((item) => item.provenance)) };
}

export interface EducationEvidence {
  /** Omit all semantic fields when the source does not explicitly specify education. */
  levels?: EducationLevel[];
  graduationDateWindow?: GraduationDateWindow;
  minimumDegree?: MinimumDegree;
  provenance: FieldProvenance[];
}

function windowsConflict(windows: GraduationDateWindow[]): boolean {
  const bounded = windows.filter((window) => window.start || window.end);
  if (bounded.length < 2) return false;
  const latestStart = bounded.map((window) => window.start).filter((item): item is string => Boolean(item)).sort().at(-1);
  const earliestEnd = bounded.map((window) => window.end).filter((item): item is string => Boolean(item)).sort()[0];
  return Boolean(latestStart && earliestEnd && latestStart > earliestEnd);
}

function combinedWindow(windows: GraduationDateWindow[]): GraduationDateWindow | undefined {
  if (!windows.length) return undefined;
  const starts = windows.map((window) => window.start).filter((item): item is string => Boolean(item)).sort();
  const ends = windows.map((window) => window.end).filter((item): item is string => Boolean(item)).sort();
  return { ...(starts[0] ? { start: starts[0] } : {}), ...(ends.at(-1) ? { end: ends.at(-1) } : {}) };
}

export function mergeEducationEvidence(evidence: readonly EducationEvidence[]): EducationAudience {
  const explicit = evidence.filter((item) => item.levels?.length || item.graduationDateWindow || item.minimumDegree);
  if (!explicit.length) return { levels: [], evidenceStatus: 'unspecified', provenance: mergeProvenance(evidence.flatMap((item) => item.provenance)) };
  const levels = [...new Set(explicit.flatMap((item) => item.levels ?? []))].sort() as EducationLevel[];
  const windows = explicit.map((item) => item.graduationDateWindow).filter((item): item is GraduationDateWindow => Boolean(item));
  const degrees = [...new Set(explicit.map((item) => item.minimumDegree).filter((item): item is MinimumDegree => Boolean(item)))];
  const conflict = degrees.length > 1 || windowsConflict(windows);
  return {
    levels,
    ...(combinedWindow(windows) ? { graduationDateWindow: combinedWindow(windows) } : {}),
    ...(degrees.length === 1 ? { minimumDegree: degrees[0] } : {}),
    evidenceStatus: conflict ? 'conflicting' : 'explicit',
    provenance: mergeProvenance(explicit.flatMap((item) => item.provenance)),
  };
}

export function educationAudienceMatches(audience: EducationAudience, userLevels: readonly EducationLevel[]): boolean {
  if (audience.evidenceStatus === 'unspecified' || audience.evidenceStatus === 'conflicting') return true;
  return audience.levels.length === 0 || audience.levels.some((level) => userLevels.includes(level));
}

export function educationAudienceLabel(audience: EducationAudience): string {
  if (audience.evidenceStatus === 'unspecified') return 'Education level not specified by employer.';
  if (audience.evidenceStatus === 'conflicting') return 'Employer education requirements conflict across official sources.';
  return audience.levels.join(', ');
}

/** Light display cleanup preserves the employer's wording rather than replacing it with tags. */
export function cleanDisplayTitle(officialTitle: string): string {
  return officialTitle.normalize('NFKC').replace(/^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\s]*/u, '').replace(/\s+/g, ' ').trim();
}

export function normalizeSearchTitle(displayTitle: string): string {
  return displayTitle.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bswe\b/g, 'software engineer')
    .replace(/\binternship\b/g, 'intern')
    .replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const DISCIPLINE_PATTERNS: Array<[DisciplineTag, RegExp]> = [
  ['ai-ml', /\b(?:ai|artificial intelligence|machine learning|ml|deep learning)\b/i],
  ['data', /\b(?:data|analytics|business intelligence)\b/i],
  ['infrastructure-cloud', /\b(?:infrastructure|cloud|platform|devops|site reliability|sre)\b/i],
  ['security', /\b(?:security|cybersecurity|infosec)\b/i],
  ['quant', /\b(?:quant|quantitative|trading)\b/i],
  ['product', /\b(?:product manager|product management)\b/i],
  ['technical-design', /\b(?:product design|ux|ui|designer)\b/i],
  ['software', /\b(?:software|developer|engineering|engineer|frontend|backend|full stack|mobile)\b/i],
];

/** Deterministic title classification; tags supplement but never replace the full title. */
export function disciplineTagsForTitle(title: string): DisciplineTag[] {
  return DISCIPLINE_PATTERNS.filter(([, pattern]) => pattern.test(title)).map(([tag]) => tag);
}

export function deriveTitleFields(
  official: ProvenancedValue<string>,
  inferenceProvenance: FieldProvenance,
): {
  official: ProvenancedValue<string>;
  display: ProvenancedValue<string>;
  search: ProvenancedValue<string>;
  disciplines: Array<ProvenancedValue<DisciplineTag>>;
} {
  const display = cleanDisplayTitle(official.value);
  return {
    official,
    display: { value: display, provenance: [inferenceProvenance] },
    search: { value: normalizeSearchTitle(display), provenance: [inferenceProvenance] },
    disciplines: disciplineTagsForTitle(display).map((value) => ({ value, provenance: [inferenceProvenance] })),
  };
}

export interface InternshipIdentityInput {
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  company: string;
  companyId?: string;
  title: string;
  location: string;
  season: string;
  seasonEvidenceStatus?: 'explicit' | 'inferred' | 'unspecified';
  content?: string;
  workMode?: WorkMode;
  evidenceSource?: EvidenceSource;
}

function seasonParts(value: string): { term?: 'spring' | 'summer' | 'fall' | 'winter'; year?: number } {
  const match = /\b(spring|summer|fall|winter)-(20\d{2})\b/i.exec(value);
  return match ? { term: match[1]!.toLowerCase() as 'spring' | 'summer' | 'fall' | 'winter', year: Number(match[2]) } : {};
}

function programType(title: string, provenance: FieldProvenance): ProvenancedValue<InternshipIdentity['programType']['value']> {
  const value = /\bco[ -]?op\b/i.test(title) ? 'co-op'
    : /\bapprenticeship\b/i.test(title) ? 'apprenticeship'
      : /\bnew[ -]?grad(?:uate)?\b/i.test(title) ? 'new-grad'
        : /\bentry[ -]?level\b/i.test(title) ? 'entry-level' : 'internship';
  return { value, provenance: [{ ...provenance, evidenceCode: `program-type-${value}` }] };
}

function educationEvidence(content: string, provenance: FieldProvenance): EducationAudience {
  const levels: EducationLevel[] = [];
  if (/\b(?:undergraduate|undergrad|bachelor(?:['’]s|s)?(?: degree)?|college student|university student)\b/i.test(content)) levels.push('undergraduate');
  if (/\b(?:master(?:['’]s|s)?(?: degree)?|graduate student)\b/i.test(content)) levels.push('masters');
  if (/\bmba\b/i.test(content)) levels.push('mba');
  if (/\b(?:ph\.?d\.?|doctoral?|doctorate)\b/i.test(content)) levels.push('doctoral');
  return mergeEducationEvidence([{ ...(levels.length ? { levels } : {}), provenance: [provenance] }]);
}

function locationParts(value: string): string[] {
  return [...new Set(value.split(/\s+\/\s+|;|\|/).map((item) => item.trim()).filter(Boolean))];
}

function atsEvidence(sourceId: string): EvidenceSource {
  return /^(?:shadow-)?(?:greenhouse|lever|ashby|workday|bytedance)-/i.test(sourceId) ? 'official-ats' : 'reviewed-community';
}

/**
 * Builds the descriptive identity consumed by catalog grouping and filtering.
 * Only row/title/content signals are used; missing education or season evidence
 * remains explicitly unspecified instead of being guessed from a role title.
 */
export function buildInternshipIdentity(input: InternshipIdentityInput): InternshipIdentity {
  const source = input.evidenceSource ?? atsEvidence(input.sourceId);
  const field = (evidenceCode: string, fieldSource = source): FieldProvenance => ({
    source: fieldSource,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    evidenceCode,
    observedAt: input.observedAt,
  });
  const inference = (evidenceCode: string): FieldProvenance => field(evidenceCode, 'deterministic-inference');
  const officialTitle: ProvenancedValue<string> = { value: input.title, provenance: [field('title')] };
  const title = deriveTitleFields(officialTitle, inference('title-derived-fields-v1'));
  const season = seasonParts(input.season);
  const seasonStatus = input.seasonEvidenceStatus
    ?? (season.term && season.year ? 'inferred' : 'unspecified');
  const seasonProvenance = [field(seasonStatus === 'explicit' ? 'season-explicit' : 'season-derived')];
  const content = input.content ?? '';
  const education = educationEvidence(content, field('education-requirement'));
  const locations = locationParts(input.location).map((name) => ({
    name,
    workMode: input.workMode ?? (/remote/i.test(name) ? 'remote' : /hybrid/i.test(name) ? 'hybrid' : /on.?site|in.?person/i.test(name) ? 'onsite' : 'unspecified') as WorkMode,
    provenance: [field('location')],
  }));
  return {
    company: {
      canonicalId: input.companyId ?? canonicalCompanyKey(input.company),
      displayName: { value: input.company, provenance: [field('company')] },
    },
    programType: programType(input.title, inference('program-type')),
    season: { ...season, evidenceStatus: seasonStatus, provenance: seasonProvenance },
    education,
    title: { official: title.official, display: title.display, search: title.search },
    disciplines: title.disciplines,
    locations,
  };
}
