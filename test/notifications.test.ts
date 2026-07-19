import { describe, expect, it } from 'vitest';
import { MemoryInternshipStore } from '../src/store.js';
import { sendDigest, sendPendingSms, summaryChunks } from '../src/notifications.js';
import type { Internship } from '../src/types.js';

function job(index: number, company = 'Unknown'): Internship { return { jobId: `j${index}`, company, title: `Role ${index}`, location: 'NYC', season: 'summer-2027', applyUrl: `https://apply.example.com/${index}`, normalizedUrl: `https://apply.example.com/${index}`, fingerprint: String(index), compensation: { raw: '$50/hr', maxHourlyUSD: 50 }, sourceReferences: [{ sourceId: 'x', document: 'README', sourceUrl: 'x', row: index, company, title: `Role ${index}`, location: 'NYC', season: 'summer-2027', applyUrl: `https://apply.example.com/${index}`, compensation: { raw: '' }, state: 'open' }], open: true, firstSeenAt: `2026-01-0${index}T00:00:00Z`, lastSeenAt: '2026-01-01T00:00:00Z', notification: { smsPending: true, digestPending: true } }; }
describe('notifications', () => {
  it('sends five individual jobs and preserves links in summary chunks', async () => {
    const store = new MemoryInternshipStore(); for (let index = 1; index <= 7; index += 1) await store.putInternship(job(index, index === 1 ? 'OpenAI' : 'Unknown'));
    const messages: string[] = []; await sendPendingSms(store, { publish: async (message) => { messages.push(message); } });
    expect(messages).toHaveLength(6); expect(messages.join('\n')).toContain('https://apply.example.com/7'); expect(await store.pendingSms()).toHaveLength(0);
  });
  it('does not mark a failed SMS and does not send empty digests', async () => {
    const store = new MemoryInternshipStore(); await store.putInternship(job(1));
    await sendPendingSms(store, { publish: async () => { throw new Error('nope'); } }); expect(await store.pendingSms()).toHaveLength(1);
    const empty = new MemoryInternshipStore(); expect(await sendDigest(empty, { send: async () => { throw new Error('should not happen'); } })).toBe(0);
  });
  it('only marks a digest after SES accepts it', async () => {
    const store = new MemoryInternshipStore(); await store.putInternship(job(1));
    await expect(sendDigest(store, { send: async () => { throw new Error('SES unavailable'); } })).rejects.toThrow('SES unavailable');
    expect(await store.pendingDigest()).toHaveLength(1);
  });
  it('splits compact summaries before their approximate limit', () => expect(summaryChunks(Array.from({ length: 20 }, (_, index) => job(index)), 200).every((chunk) => chunk.length >= 1)).toBe(true));
});
