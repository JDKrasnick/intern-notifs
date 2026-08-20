import { describe, expect, it, vi } from 'vitest';
import { evaluateSourceFreshness } from '../src/ingestion/monitoring.js';
import { IngestionRunner } from '../src/poll.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { SourceFetchError } from '../src/sources/source-error.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { SourceAdapter } from '../src/types.js';

describe('ingestion health and retry policy', () => {
  it('emits sanitized conditional-request metrics without validator values', async () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)));
    try {
      await new IngestionRunner([{
        id: 'greenhouse-acme',
        async fetch() {
          return {
            sourceId: 'greenhouse-acme', rawRowCount: 0, listings: [], notModified: true,
            unchangedReason: 'not_modified' as const,
            conditionalRequest: { attempted: true, notModified: true, validatorChanged: false },
            checkpoint: { sourceId: 'greenhouse-acme', successfulFetches: 1, lastRowCount: 0 },
          };
        },
      }], new MemoryInternshipStore()).run();
    } finally {
      log.mockRestore();
    }
    const event = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === 'source_fetch_completed');
    expect(event).toMatchObject({
      conditionalRequestAttempted: true,
      conditionalRequestNotModified: true,
      validatorChanged: false,
      ConditionalRequestAttempted: 1,
      ConditionalRequestNotModified: 1,
      ValidatorChanged: 0,
    });
    expect(JSON.stringify(event)).not.toContain('If-None-Match');
  });

  it('retries transport, 429, and 5xx failures up to three bounded attempts', async () => {
    const store = new MemoryInternshipStore();
    let attempts = 0;
    const adapter: SourceAdapter = {
      id: 'lever-acme',
      async fetch() {
        attempts += 1;
        if (attempts < 3) throw new SourceFetchError('temporary provider failure', 'http', 503);
        return {
          sourceId: 'lever-acme',
          rawRowCount: 0,
          listings: [],
          notModified: false,
          checkpoint: { sourceId: 'lever-acme', successfulFetches: 1, lastRowCount: 0 },
        };
      },
    };
    const report = await new IngestionRunner([adapter], store).run();
    expect(attempts).toBe(3);
    expect(report.failures).toEqual([]);
    expect(await store.getSourceHealth('lever-acme')).toMatchObject({
      outcome: 'success_changed',
      consecutiveFailures: 0,
      counts: { raw: 0, eligible: 0 },
    });
  });

  it('retries a Markdown document that answers with a server error', async () => {
    const store = new MemoryInternshipStore();
    let attempts = 0;
    const adapter = new GitHubMarkdownAdapter({
      id: 'markdown-fixture', owner: 'owner', repo: 'repo',
      documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return new Response('rate limited', { status: 503 });
        return new Response('| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n'
          + '| Acme | Software Engineering Intern | Remote | [Apply](https://careers.example.test/acme) |');
      },
    });
    const report = await new IngestionRunner([adapter], store).run();
    expect(attempts).toBe(3);
    expect(report.failures).toEqual([]);
    expect(await store.getSourceHealth('markdown-fixture')).toMatchObject({ provider: 'github', outcome: 'success_changed', consecutiveFailures: 0 });
  });

  it('does not retry schema, identity, or configuration-class failures', async () => {
    const store = new MemoryInternshipStore();
    let attempts = 0;
    const adapter: SourceAdapter = {
      id: 'lever-acme',
      async fetch() {
        attempts += 1;
        throw new SourceFetchError('invalid source identity', 'identity');
      },
    };
    const report = await new IngestionRunner([adapter], store).run();
    expect(attempts).toBe(1);
    expect(report.failures).toEqual(['invalid source identity']);
    expect(await store.getSourceHealth('lever-acme')).toMatchObject({
      outcome: 'application_host_mismatch',
      consecutiveFailures: 1,
      diagnosticCategory: 'identity',
    });
  });

  it('reports low-cardinality stale counts while retaining source IDs for diagnostics', () => {
    const now = new Date('2026-07-29T13:00:00.000Z');
    const result = evaluateSourceFreshness([
      {
        sourceId: 'lever-old', provider: 'lever', lastAttemptAt: '2026-07-29T12:50:00.000Z',
        lastSuccessAt: '2026-07-29T11:00:00.000Z', outcome: 'failed', durationMs: 100, consecutiveFailures: 2,
      },
      {
        sourceId: 'greenhouse-fresh', provider: 'greenhouse', lastAttemptAt: '2026-07-29T12:50:00.000Z',
        lastSuccessAt: '2026-07-29T12:50:00.000Z', outcome: 'unchanged', durationMs: 80, consecutiveFailures: 0,
      },
      {
        sourceId: 'github-never', provider: 'github', lastAttemptAt: '2026-07-29T12:50:00.000Z',
        outcome: 'failed', durationMs: 20, consecutiveFailures: 1,
      },
    ], now);
    expect(result).toEqual({
      staleCount: 2,
      byProvider: { github: 1, lever: 1, greenhouse: 0, ashby: 0, unknown: 0 },
      staleSourceIds: ['github-never', 'lever-old'],
    });
  });
});
