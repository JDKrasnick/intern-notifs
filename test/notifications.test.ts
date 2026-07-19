import { describe, expect, it } from 'vitest';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import { compactRoleTitle, ExpoPushPublisher, NtfyPublisher, renderPushTemplate, sendDigest, sendNewJobNotifications, sendPendingNotifications, summaryChunks, type PushMessage } from '../src/notifications.js';
import type { Internship } from '../src/types.js';

function job(index: number, company = 'Unknown'): Internship { return { jobId: `j${index}`, company, title: `Role ${index}`, location: 'NYC', season: 'summer-2027', applyUrl: `https://apply.example.com/${index}`, normalizedUrl: `https://apply.example.com/${index}`, fingerprint: String(index), compensation: { raw: '$50/hr', maxHourlyUSD: 50 }, sourceReferences: [{ sourceId: 'x', document: 'README', sourceUrl: 'x', row: index, company, title: `Role ${index}`, location: 'NYC', season: 'summer-2027', applyUrl: `https://apply.example.com/${index}`, compensation: { raw: '' }, state: 'open' }], open: true, firstSeenAt: `2026-01-0${index}T00:00:00Z`, lastSeenAt: '2026-01-01T00:00:00Z', notification: { smsPending: true, digestPending: true } }; }
describe('notifications', () => {
  it('sends five individual jobs and preserves links in summary chunks', async () => {
    const store = new MemoryInternshipStore(); for (let index = 1; index <= 7; index += 1) await store.putInternship(job(index, index === 1 ? 'OpenAI' : 'Unknown'));
    const messages: PushMessage[] = []; await sendPendingNotifications(store, { publish: async (message) => { messages.push(message); } });
    expect(messages).toHaveLength(6); expect(messages[0]).toMatchObject({ title: 'Role 1 — OpenAI', body: 'NYC · summer-2027 · $50/hr\nhttps://apply.example.com/1', click: 'https://apply.example.com/1' }); expect(messages.map((message) => message.body).join('\n')).toContain('https://apply.example.com/7'); expect(await store.pendingSms()).toHaveLength(0);
  });
  it('does not mark a failed SMS and does not send empty digests', async () => {
    const store = new MemoryInternshipStore(); await store.putInternship(job(1));
    await sendPendingNotifications(store, { publish: async () => { throw new Error('nope'); } }); expect(await store.pendingSms()).toHaveLength(1);
    const empty = new MemoryInternshipStore(); expect(await sendDigest(empty, { send: async () => { throw new Error('should not happen'); } })).toBe(0);
  });
  it('only marks a digest after SES accepts it', async () => {
    const store = new MemoryInternshipStore(); await store.putInternship(job(1));
    await expect(sendDigest(store, { send: async () => { throw new Error('SES unavailable'); } })).rejects.toThrow('SES unavailable');
    expect(await store.pendingDigest()).toHaveLength(1);
  });
  it('splits compact summaries before their approximate limit', () => expect(summaryChunks(Array.from({ length: 20 }, (_, index) => job(index)), 200).every((chunk) => chunk.length >= 1)).toBe(true));
  it('supports safe user-selected title and description fields', async () => {
    const listing = { ...job(1, 'OpenAI'), title: 'Software\nIntern' };
    expect(renderPushTemplate('{company}: {title}', listing)).toBe('OpenAI: Software Intern');
    expect(renderPushTemplate('{season} | {compensation} | {url}', listing)).toBe('summer-2027 | $50/hr | https://apply.example.com/1');
    expect(compactRoleTitle('Software Engineering Intern')).toBe('SWE');
    expect(compactRoleTitle('Machine Learning Internship')).toBe('ML');
    expect(compactRoleTitle('Cloud Infrastructure Software Engineering Intern')).toBe('SWE');
    expect(compactRoleTitle('Software Engineering Intern', { 'software engineering': 'Dev' })).toBe('Dev');
    expect(renderPushTemplate('{focus}{postedDetail}', { ...listing, title: 'Machine Learning Intern', sourceReferences: [{ ...listing.sourceReferences[0], postedAt: '2026-07-19' }] })).toBe('Focus: AI/ML · Posted: 2026-07-19');
    const store = new MemoryInternshipStore(); await store.putInternship({ ...listing, title: 'Software Engineering Intern', notification: { smsPending: true, digestPending: false } });
    const pushes: PushMessage[] = []; await sendPendingNotifications(store, { publish: async (message) => { pushes.push(message); } }); expect(pushes[0]?.tags).toEqual(['computer']);
  });
  it('publishes a high-priority push message and rejects non-success responses', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await new NtfyPublisher('private topic', 'https://push.example.test', async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 200 }); }).publish({ title: 'Role — Company', body: 'Remote\nhttps://apply.example.com', click: 'https://apply.example.com', tags: ['computer'] });
    expect(calls[0]).toMatchObject({ url: 'https://push.example.test', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'private topic', title: 'Role — Company', message: 'Remote\nhttps://apply.example.com', priority: 4, tags: ['computer'], click: 'https://apply.example.com' }) } });
    await expect(new NtfyPublisher('topic', 'https://push.example.test', async () => new Response('', { status: 503 })).publish({ title: 'Test', body: 'hello' })).rejects.toThrow('HTTP 503');
  });
  it('uses a user-selected compact template over Expo while preserving the legacy defaults', async () => {
    const users = new MemoryUserStore(); const calls: RequestInit[] = []; const internship = job(1, 'OpenAI');
    await users.putPreferences({ userId: 'user-1', filter: {}, alertsEnabled: true, onboardingComplete: true, push: { titleTemplate: '{company}: {title}', descriptionTemplate: '{season} | {url}' }, updatedAt: '2026-07-19T00:00:00Z' });
    await users.putDevice({ userId: 'user-1', token: 'ExponentPushToken[test]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00Z', updatedAt: '2026-07-19T00:00:00Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async (_url, init) => { calls.push(init ?? {}); return new Response(JSON.stringify({ data: { id: 'ticket-1', status: 'ok' } }), { status: 200 }); });
    await sendNewJobNotifications([internship], users, publisher);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ title: 'OpenAI: Role 1', body: 'summer-2027 | https://apply.example.com/1', data: { jobId: 'j1' } });
  });
});
