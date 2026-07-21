import { describe, expect, it } from 'vitest';
import { Poller } from '../src/poll.js';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { GitHubMarkdownAdapter, defaultSources } from '../src/sources/github.js';
import { defaultSources as productionSources } from '../src/sources/index.js';
import { parseQuantInternshipMarkdown } from '../src/sources/quant.js';
import { MemoryInternshipStore } from '../src/store.js';

describe('GitHub source adapters', () => {
  it('ships each requested feed and document', () => {
    expect(defaultSources.map((source) => source.id)).toEqual(['vanshb03-summer-2027', 'simplify-summer-2026', 'zapply-2027', 'speedyapply-2027-swe', 'speedyapply-2027-ai', 'northwestern-fintech-2027-quant', 'canadian-tech-2027']);
  });
  it('registers only reviewed Lever boards in the production source registry', () => {
    expect(productionSources.map((source) => source.id)).toEqual(expect.arrayContaining(['lever-palantir', 'lever-plusai', 'lever-hermeus', 'lever-xsolla']));
  });
  it('uses document-specific ETags and returns a no-change result', async () => {
    const calls: RequestInit[] = [];
    const adapter = new GitHubMarkdownAdapter({ id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }], fetchImpl: async (_url, init) => { calls.push(init ?? {}); return new Response(null, { status: 304 }); } });
    const result = await adapter.fetch({ sourceId: 'fixture', successfulFetches: 1, documentEtags: { 'README.md': '"abc"' } });
    expect(result.notModified).toBe(true); expect(calls[0].headers).toEqual({ 'If-None-Match': '"abc"' });
  });
  it('assigns the employer category while polling a GitHub Markdown source', async () => {
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response('| Company | Role | Location | Apply |\n| --- | --- | --- | --- |\n| Google | Software Engineering Intern | Remote | [Apply](https://careers.example.test/google) |'),
    });
    const store = new MemoryInternshipStore();
    await new Poller([adapter], store).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Google', employerCategory: 'faang' });
  });
  it('recognizes a Posting column as the direct application URL', () => {
    const rows = parseInternshipMarkdown('| Company | Position | Posting |\n| --- | --- | --- |\n| Acme | AI Intern | <a href="https://careers.example.test/acme">Apply</a> |', { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://github.com/example/roles', season: 'summer-2027' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applyUrl).toBe('https://careers.example.test/acme');
  });
  it('parses quant roles nested under an employer heading', () => {
    const rows = parseQuantInternshipMarkdown('## Acme Capital\n\n**Locations**: Chicago\n\n|Role|Links|\n|---|---|\n|SWE|[✅ C++](https://careers.example.test/acme-cpp) [✅ Python](https://careers.example.test/acme-python)|', { sourceId: 'quant', document: 'README.md', sourceUrl: 'https://github.com/example/quant', season: 'summer-2027' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ company: 'Acme Capital', title: 'Software Engineering Intern — C++', location: 'Chicago' });
  });
});
