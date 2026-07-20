/**
 * Broad company buckets for discovery and alert filtering. They are intentionally
 * not a ranking or a statement about the quality of an individual internship.
 *
 * The richer, private employer review inventory lives in EMPLOYERS.json. This
 * small deployable allowlist covers classifications that can be applied safely
 * at ingest time. Unknown companies always remain `normal`.
 */
export const employerCategories = ['faang', 'startup', 'normal'] as const;
export type EmployerCategory = typeof employerCategories[number];

const suffixes = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited', 'llc', 'ltd', 'plc']);

function companyKey(value: string) {
  const terms = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (terms.length > 1 && suffixes.has(terms.at(-1)!)) terms.pop();
  return terms.join(' ');
}

const faang = new Set([
  'alphabet', 'google', 'google deepmind',
  'amazon', 'amazon web services', 'aws',
  'apple',
  'meta', 'facebook', 'instagram', 'whatsapp',
  'netflix'
].map(companyKey));

/**
 * Initial verified YC-backed/startup set. It is deliberately conservative and
 * should grow only through a reviewed update to the private employer catalog.
 */
const startups = new Set([
  'astranis',
  'benchling',
  'brex',
  'checkr',
  'deel',
  'gusto',
  'mercury',
  'modern treasury',
  'notion',
  'plaid',
  'posthog',
  'retool',
  'rippling',
  'scale ai',
  'sentry', 'sentry io',
  'sourcegraph',
  'supabase',
  'vanta',
  'vercel',
  'webflow',
  'weights biases',
  'zapier'
].map(companyKey));

export function employerCategory(company: string): EmployerCategory {
  const key = companyKey(company);
  if (faang.has(key)) return 'faang';
  if (startups.has(key)) return 'startup';
  return 'normal';
}
