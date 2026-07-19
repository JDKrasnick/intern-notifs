import { describe, expect, it } from 'vitest';
import { runRuntimeCommand } from '../src/runtime.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing: RawListing = { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://example.com', row: 1, company: 'Acme', title: 'Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://example.com/apply', compensation: { raw: '' }, state: 'open', fetchedAt: '2026-01-01T00:00:00Z' };
const adapter: SourceAdapter = { id: 'fixture', async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { return { sourceId: 'fixture', listings: [listing], notModified: false, checkpoint: { sourceId: 'fixture', successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: 1 } }; } };
describe('AWS runtime commands', () => {
  it('uses the same quiet-baseline poll behavior as the CLI', async () => {
    const store = new MemoryInternshipStore(); const messages: string[] = [];
    const result = await runRuntimeCommand('poll', { store, config: { ntfyTopic: 'test-topic', sesFrom: 'a@example.com', sesTo: 'b@example.com' }, sources: [adapter], notificationPublisher: { publish: async (message) => { messages.push(message); } } });
    expect(result).toMatchObject({ poll: { baselineSources: ['fixture'], newJobs: [] }, notifications: { sent: 0, failed: 0 } }); expect(messages).toEqual([]);
  });
  it('does not send an empty digest', async () => {
    const store = new MemoryInternshipStore(); let sent = false;
    expect(await runRuntimeCommand('digest', { store, config: { ntfyTopic: 'test-topic', sesFrom: 'a@example.com', sesTo: 'b@example.com' }, emailSender: { send: async () => { sent = true; } } })).toEqual({ digested: 0 }); expect(sent).toBe(false);
  });
});
