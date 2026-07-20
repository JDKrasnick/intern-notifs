import { describe, expect, it } from 'vitest';
import { Poller } from '../src/poll.js';
import { GitHubMarkdownAdapter, defaultSources } from '../src/sources/github.js';
import { MemoryInternshipStore } from '../src/store.js';

describe('GitHub source adapters', () => {
  it('ships each requested feed and document', () => {
    expect(defaultSources.map((source) => source.id)).toEqual(['vanshb03-summer-2027', 'simplify-summer-2026', 'zapply-2027', 'speedyapply-2027-swe', 'northwestern-fintech-2027-quant', 'canadian-tech-2027']);
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
});
