import { describe, expect, it } from 'vitest';
import { GitHubMarkdownAdapter, defaultSources } from '../src/sources/github.js';

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
});
