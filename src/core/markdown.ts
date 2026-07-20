import { parseCompensation } from './normalize.js';
import type { RawListing } from '../types.js';

interface Table { headers: string[]; rows: Array<{ cells: string[]; row: number }>; }

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let value = ''; let escaped = false;
  for (const char of body) {
    if (escaped) { value += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === '|') { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}

function isSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tables(markdown: string): Table[] {
  const lines = markdown.replace(/\r/g, '').split('\n'); const result: Table[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].includes('|') || !isSeparator(lines[index + 1])) continue;
    const headers = splitRow(lines[index]); const rows: Table['rows'] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes('|') && !/^\s*$/.test(lines[cursor])) {
      const cells = splitRow(lines[cursor]);
      if (cells.length === headers.length) rows.push({ cells, row: cursor + 1 });
      cursor += 1;
    }
    result.push({ headers, rows }); index = cursor - 1;
  }
  return result;
}

function text(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function links(value: string): string[] {
  const values = [
    ...[...value.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)].map((m) => m[1]),
    ...[...value.matchAll(/<a\s+[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi)].map((m) => m[1]),
    ...[...value.matchAll(/(?<!["'(])(https?:\/\/[^\s<>)]+)/gi)].map((m) => m[1])
  ];
  return [...new Set(values.map((link) => link.replace(/[),.;]+$/, '')).filter((link) => { try { return /^https?:$/.test(new URL(link).protocol); } catch { return false; } }))];
}

function indexOf(headers: string[], expressions: RegExp[]): number {
  return headers.findIndex((header) => expressions.some((expression) => expression.test(text(header).toLowerCase())));
}

export interface MarkdownParseOptions { sourceId: string; document: string; sourceUrl: string; season: string; fetchedAt?: string; }

/** Parses only GFM table syntax; HTML is treated as inert text and only href values are read. */
export function parseInternshipMarkdown(markdown: string, options: MarkdownParseOptions): RawListing[] {
  const parsed: RawListing[] = []; let inheritedCompany = '';
  for (const table of tables(markdown)) {
    const companyAt = indexOf(table.headers, [/company|employer/]);
    const titleAt = indexOf(table.headers, [/role|position|title/]);
    const locationAt = indexOf(table.headers, [/location/]);
    const applyAt = indexOf(table.headers, [/apply|link|application/]);
    const compensationAt = indexOf(table.headers, [/compensation|salary|pay/]);
    const dateAt = indexOf(table.headers, [/date|posted/]);
    if (companyAt < 0 || titleAt < 0 || applyAt < 0) continue;
    for (const row of table.rows) {
      const values = row.cells.map(text); const rawRow = row.cells.join(' ').toLowerCase();
      const closed = /\b(closed|inactive|filled|expired)\b/.test(rawRow) || rawRow.includes('🔒');
      const requirements = {
        requiresUsCitizenship: rawRow.includes('🇺🇸') || /\b(?:requires?|must be)\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(rawRow),
        advancedDegreeRequired: rawRow.includes('🎓') || /\b(?:advanced degree|master'?s|ph\.?d\.?|mba)\b/i.test(rawRow)
      };
      let company = values[companyAt] ?? '';
      if (/^↳|^\u21b3/.test(company)) company = inheritedCompany;
      else if (company) inheritedCompany = company;
      const title = values[titleAt] ?? ''; const applyUrl = links(row.cells[applyAt] ?? '')[0] ?? links(row.cells.join(' '))[0];
      if (!company || !title || !applyUrl) continue;
      parsed.push({
        sourceId: options.sourceId, document: options.document, sourceUrl: options.sourceUrl, row: row.row,
        company, title, location: locationAt >= 0 ? values[locationAt] || 'Unspecified' : 'Unspecified', season: options.season, applyUrl,
        compensation: parseCompensation(compensationAt >= 0 ? values[compensationAt] ?? '' : ''), requirements, state: closed ? 'closed' : 'open',
        postedAt: dateAt >= 0 ? values[dateAt] || undefined : undefined, fetchedAt: options.fetchedAt ?? new Date().toISOString()
      });
    }
  }
  return parsed;
}
