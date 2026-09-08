/** Discipline tag colors - browser-safe, shared by API and UI. */

export type DisciplineTag = 'software' | 'ai-ml' | 'data' | 'infrastructure-cloud' | 'security' | 'quant' | 'product' | 'technical-design';

export interface DisciplineStyle {
  backgroundColor: string;
  borderColor: string;
  color: string;
  label: string;
  /** Exact value stored in catalog projections and accepted by the API filter. */
  filterValue: string;
}

const DISCIPLINE_STYLES: Record<DisciplineTag, DisciplineStyle> = {
  // Important ones - strong, distinct, accessible
  software: { backgroundColor: '#DBEAFE', borderColor: '#93C5FD', color: '#1E40AF', label: 'SWE', filterValue: 'SWE' },
  quant: { backgroundColor: '#EDE9FE', borderColor: '#C4B5FD', color: '#6D28D9', label: 'Quant', filterValue: 'Quant/Fintech' },
  'ai-ml': { backgroundColor: '#FCE7F3', borderColor: '#F9A8D4', color: '#9F1239', label: 'AI/ML', filterValue: 'AI/ML' },
  data: { backgroundColor: '#CCFBF1', borderColor: '#5EEAD4', color: '#115E59', label: 'Data', filterValue: 'Data' },
  // Secondary - vivid, easy to tell (more saturated than infra)
  'infrastructure-cloud': { backgroundColor: '#F1F5F9', borderColor: '#CBD5E1', color: '#334155', label: 'Infra', filterValue: 'Cloud/Infra' },
  security: { backgroundColor: '#FECACA', borderColor: '#F87171', color: '#7F1D1D', label: 'Security', filterValue: 'Security' },
  product: { backgroundColor: '#FDE68A', borderColor: '#F59E0B', color: '#78350F', label: 'Product', filterValue: 'Product' },
  'technical-design': { backgroundColor: '#A7F3D0', borderColor: '#34D399', color: '#064E3B', label: 'Design', filterValue: 'Design' },
};

// Aliases for API values like "SWE", "Quant", "SWE " etc, and human display variants
const ALIAS_MAP: Record<string, DisciplineTag> = {
  'swe': 'software', 'software': 'software', 'software engineering': 'software', 'eng': 'software', 'engineering': 'software', 'developer': 'software', 'sde': 'software',
  'quant': 'quant', 'quant/fintech': 'quant', 'quantitative': 'quant', 'trading': 'quant',
  'ai': 'ai-ml', 'ai-ml': 'ai-ml', 'ai/ml': 'ai-ml', 'aiml': 'ai-ml', 'machine learning': 'ai-ml', 'ml': 'ai-ml', 'artificial intelligence': 'ai-ml', 'deep learning': 'ai-ml',
  'data': 'data', 'analytics': 'data', 'business intelligence': 'data',
  'infra': 'infrastructure-cloud', 'cloud/infra': 'infrastructure-cloud', 'infrastructure': 'infrastructure-cloud', 'infrastructure-cloud': 'infrastructure-cloud', 'cloud': 'infrastructure-cloud', 'platform': 'infrastructure-cloud', 'devops': 'infrastructure-cloud', 'sre': 'infrastructure-cloud',
  'security': 'security', 'cybersecurity': 'security', 'infosec': 'security',
  'product': 'product', 'product management': 'product', 'pm': 'product',
  'design': 'technical-design', 'technical-design': 'technical-design', 'ux': 'technical-design', 'ui': 'technical-design', 'product design': 'technical-design',
};

const FALLBACK_VARIANTS: DisciplineStyle[] = [
  { backgroundColor: '#FEF9C3', borderColor: '#FDE68A', color: '#713F12', label: '', filterValue: '' },
  { backgroundColor: '#E0E7FF', borderColor: '#A5B4FC', color: '#3730A3', label: '', filterValue: '' },
  { backgroundColor: '#F3E8FF', borderColor: '#D8B4FE', color: '#6B21A8', label: '', filterValue: '' },
  { backgroundColor: '#FFEDD5', borderColor: '#FDBA74', color: '#7C2D12', label: '', filterValue: '' },
  { backgroundColor: '#D1FAE5', borderColor: '#6EE7B7', color: '#064E3B', label: '', filterValue: '' },
  { backgroundColor: '#FFE4E6', borderColor: '#FECDD3', color: '#881337', label: '', filterValue: '' },
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function disciplineStyleFor(raw: string): DisciplineStyle {
  const key = raw.trim().toLowerCase();
  const mapped = ALIAS_MAP[key];
  if (mapped) return DISCIPLINE_STYLES[mapped];
  // Try direct tag match case-insensitive
  const direct = Object.keys(DISCIPLINE_STYLES).find(k => k.toLowerCase() === key) as DisciplineTag | undefined;
  if (direct) return DISCIPLINE_STYLES[direct];
  // Fallback: deterministic random variant
  const idx = hashString(key) % FALLBACK_VARIANTS.length;
  const variant = FALLBACK_VARIANTS[idx]!;
  return { ...variant, label: raw.trim().slice(0, 18) || 'Other' };
}

export function disciplineLabelFor(raw: string): string {
  return disciplineStyleFor(raw).label;
}

export function disciplineCanonicalTag(raw: string): DisciplineTag | undefined {
  const key = raw.trim().toLowerCase();
  const mapped = ALIAS_MAP[key];
  if (mapped) return mapped;
  const direct = Object.keys(DISCIPLINE_STYLES).find(k => k.toLowerCase() === key) as DisciplineTag | undefined;
  if (direct) return direct;
  return undefined;
}

/** Folded key used for alias-aware comparison; canonical tag when known, otherwise folded raw. */
export function disciplineKey(raw: string): string {
  return disciplineCanonicalTag(raw) ?? raw.trim().toLowerCase();
}

export function disciplineVariantsFor(tag: DisciplineTag): string[] {
  const variants = new Set<string>();
  variants.add(tag.toLowerCase());
  variants.add(DISCIPLINE_STYLES[tag].label.toLowerCase());
  variants.add(DISCIPLINE_STYLES[tag].filterValue.toLowerCase());
  for (const [alias, canonical] of Object.entries(ALIAS_MAP)) {
    if (canonical === tag) variants.add(alias.toLowerCase());
  }
  return [...variants];
}

export function disciplineSearchVariants(raw: string): string[] {
  const canonical = disciplineCanonicalTag(raw);
  if (!canonical) return [raw.trim().toLowerCase()];
  return disciplineVariantsFor(canonical);
}

export function allDisciplineTags(): DisciplineTag[] {
  return Object.keys(DISCIPLINE_STYLES) as DisciplineTag[];
}
export function allDisciplineStyles(): Array<{ tag: DisciplineTag; style: DisciplineStyle }> {
  return (Object.keys(DISCIPLINE_STYLES) as DisciplineTag[]).map(tag => ({ tag, style: DISCIPLINE_STYLES[tag] }));
}
