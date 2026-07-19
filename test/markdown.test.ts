import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { normalizeUrl } from '../src/core/normalize.js';

const fixture = readFileSync(new URL('./fixtures/internships.md', import.meta.url), 'utf8');
describe('GFM internship parser', () => {
  it('inherits companies, reads inert HTML links, parses pay, and ignores closed rows', () => {
    const rows = parseInternshipMarkdown(fixture, { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://example.com', season: 'summer-2027', fetchedAt: '2026-01-01T00:00:00Z' });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ company: 'Acme', applyUrl: 'https://apply.example.com/quant', state: 'open' });
    expect(rows[0].compensation.maxHourlyUSD).toBe(55);
    expect(rows[1].compensation.maxHourlyUSD).toBeCloseTo(120000 / 2080);
  });
  it('removes tracking data and fragments while retaining meaningful query data', () => {
    expect(normalizeUrl('HTTPS://Jobs.Example.com/a?utm_source=x&id=3#section')).toBe('https://jobs.example.com/a?id=3');
  });
  it('skips malformed tables instead of inventing listings', () => {
    expect(parseInternshipMarkdown('| Company | Role |\n| --- | --- |\n| Acme | Intern |', { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://example.com', season: 'summer-2027' })).toEqual([]);
  });
});
