import type { MarkdownParseOptions } from '../core/markdown.js';
import type { RawListing } from '../types.js';

const titles: Record<string, string> = {
  QD: 'Quantitative Developer Intern',
  QR: 'Quantitative Research Intern',
  QT: 'Quantitative Trading Intern',
  SWE: 'Software Engineering Intern',
  HW: 'Hardware Engineering Intern'
};

function plain(value: string) {
  return value.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function roleTitle(role: string, label: string) {
  const base = titles[role.toUpperCase()] ?? `${role} Intern`;
  const specialization = plain(label).replace(/[✅❌]/g, '').replace(/^apply$/i, '').trim();
  return specialization ? `${base} — ${specialization}` : base;
}

/** Parses the company-section / Role|Links layout used by NUFT's quant list. */
export function parseQuantInternshipMarkdown(markdown: string, options: MarkdownParseOptions): RawListing[] {
  const listings: RawListing[] = []; let company = ''; let location = 'Unspecified';
  for (const [index, line] of markdown.replace(/\r/g, '').split('\n').entries()) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { company = plain(heading[1]); location = 'Unspecified'; continue; }
    const locationLine = line.match(/^\*\*Locations\*\*:\s*(.+?)\s*$/i);
    if (locationLine) { location = plain(locationLine[1]) || 'Unspecified'; continue; }
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!row || !company || /^role$/i.test(plain(row[1])) || /^-+$/.test(row[1].trim())) continue;
    for (const link of row[2].matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi)) {
      const applyUrl = link[2].replace(/&amp;/gi, '&');
      try { if (!/^https?:$/.test(new URL(applyUrl).protocol)) continue; } catch { continue; }
      const raw = `${row[1]} ${row[2]}`;
      listings.push({
        sourceId: options.sourceId, document: options.document, sourceUrl: options.sourceUrl, row: index + 1,
        company, title: roleTitle(plain(row[1]), link[1]), location, season: options.season, applyUrl,
        compensation: { raw: '' },
        requirements: { requiresUsCitizenship: raw.includes('🇺🇸'), advancedDegreeRequired: raw.includes('🎓') },
        state: /\b(closed|inactive|filled|expired)\b/i.test(raw) || raw.includes('🔒') ? 'closed' : 'open',
        fetchedAt: options.fetchedAt ?? new Date().toISOString()
      });
    }
  }
  return listings;
}
