/**
 * Curated lists publish truncated role titles — zapply cuts at roughly 37
 * characters, mid-word — and a truncated title is both unreadable in the feed
 * and unmatchable against the same role from another source. Repairing it to a
 * known title restores the fingerprint the other sources already agree on.
 */

/**
 * Role titles observed whole and repeatedly across the reviewed sources,
 * longest first so the most specific known title wins a prefix match.
 */
export const canonicalRoleTitles: string[] = [
  'Machine Learning Engineer Intern',
  'Machine Learning Research Intern',
  'Quantitative Research Intern',
  'Quantitative Trading Intern',
  'Quantitative Developer Intern',
  'Quantitative Researcher Intern',
  'Quantitative Trader Intern',
  'Quantitative Analyst Intern',
  'Full Stack Software Engineer Intern',
  'Embedded Software Engineer Intern',
  'Frontend Software Engineer Intern',
  'Backend Software Engineer Intern',
  'Forward Deployed Software Engineer Intern',
  'Site Reliability Engineer Intern',
  'Security Engineering Intern',
  'Software Engineering Intern',
  'Software Development Intern',
  'Software Developer Intern',
  'Software Engineer Intern',
  'Systems Engineering Intern',
  'Firmware Engineering Intern',
  'Hardware Engineer Intern',
  'Data Engineering Intern',
  'Data Science Intern',
  'Data Scientist Intern',
  'Data Analyst Intern',
  'Frontend Engineer Intern',
  'Backend Engineer Intern',
  'Product Manager Intern',
  'Research Intern',
  'Engineering Intern',
  'Technology Intern',
  'Firmware Intern',
  'AI Engineer Intern',
  'AI Intern',
].sort((a, b) => b.length - a.length);

const TRUNCATION = /(?:\.{3}|…)\s*$/;

export function isTruncatedTitle(title: string): boolean {
  return TRUNCATION.test(title.trim());
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function titleTokens(title: string): string[] {
  return normalize(title).split(' ').filter(Boolean);
}

/**
 * Proportion of the shorter title's words that the longer one also uses, so a
 * truncated or suffixed variant still recognises its fuller form.
 */
export function titleSimilarity(left: string, right: string): number {
  const a = new Set(titleTokens(left));
  const b = new Set(titleTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

const SIMILAR_TITLE_THRESHOLD = 0.8;

/** Two postings describe one role when the employer agrees and the titles substantially do. */
export function sameRole(
  left: { company: string; title: string },
  right: { company: string; title: string },
): boolean {
  if (normalize(left.company) !== normalize(right.company)) return false;
  const a = normalize(left.title);
  const b = normalize(right.title);
  return a === b || a.startsWith(b) || b.startsWith(a) || titleSimilarity(a, b) >= SIMILAR_TITLE_THRESHOLD;
}

/**
 * Repairs a truncated title to the longest known title it begins with, falling
 * back to the readable text before the cut. `candidates` supplies titles already
 * seen for the same employer, which beat the shared list because they carry the
 * team and location detail a generic title cannot.
 */
export function repairTitle(title: string, candidates: readonly string[] = []): string {
  const trimmed = title.trim();
  if (!isTruncatedTitle(trimmed)) return trimmed;
  const prefix = normalize(trimmed.replace(TRUNCATION, ''));
  if (!prefix) return trimmed;
  const employerMatch = [...candidates]
    .filter((candidate) => normalize(candidate).startsWith(prefix))
    .sort((a, b) => a.length - b.length)[0];
  if (employerMatch) return employerMatch;
  const canonical = canonicalRoleTitles.find((candidate) => prefix.startsWith(normalize(candidate)));
  if (canonical) return canonical;
  // Nothing matched, so drop the dangling partial word rather than keep "Intern (Rec".
  const readable = trimmed.replace(TRUNCATION, '').trim().replace(/[\s([{,\-–—/]+\S*$/, '').trim();
  return readable || trimmed.replace(TRUNCATION, '').trim();
}
