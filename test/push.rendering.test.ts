import { describe, expect, it } from 'vitest';
import { ExpoPushPublisher, sendNewJobNotifications } from '../src/notifications.js';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const role = (row: number, title: string, location: string): RawListing => ({
  sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://github.com/example/roles', row, company: 'Acme', title, location,
  season: 'summer-2027', applyUrl: `https://careers.example.test/${row}`, compensation: { raw: '$50/hr', maxHourlyUSD: 50 },
  state: 'open', postedAt: '2026-07-19', fetchedAt: '2026-07-19T12:00:00.000Z',
});
class Adapter implements SourceAdapter {
  readonly id = 'fixture';
  constructor(private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } };
  }
}

describe('rendered native job alerts', () => {
  it('preserves each role’s precise location through poll, matching, and Expo payload rendering', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putCheckpoint({ sourceId: 'fixture', successfulFetches: 1, lastRowCount: 0 });
    const polled = await new Poller([new Adapter([
      role(1, 'Software Engineering Intern', 'New York, NY'),
      role(2, 'Machine Learning Intern', 'Remote (US)'),
      role(3, 'Backend Engineering Intern', 'Austin, TX'),
    ])], jobs).poll();
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'student', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'student', token: 'ExponentPushToken[student]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    const payloads: Array<{ title: string; body: string; data: { jobId: string } }> = [];
    const publisher = new ExpoPushPublisher('https://push.example.test', async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)) as { title: string; body: string; data: { jobId: string } });
      return new Response(JSON.stringify({ data: { id: `ticket-${payloads.length}`, status: 'ok' } }), { status: 200 });
    });

    expect(await sendNewJobNotifications(polled.newJobs, users, publisher)).toEqual({ sent: 3, skipped: 0, failed: 0 });
    const messages = new Map(payloads.map((payload) => [payload.data.jobId, payload]));
    const byTitle = new Map(polled.newJobs.map((job) => [job.title, messages.get(job.jobId)]));
    expect(byTitle.get('Software Engineering Intern')).toMatchObject({ title: 'SWE — Acme', body: 'New York, NY · summer-2027 · $50/hr\nFocus: SWE · Posted: 2026-07-19\nhttps://careers.example.test/1' });
    expect(byTitle.get('Machine Learning Intern')).toMatchObject({ title: 'ML — Acme', body: 'Remote (US) · summer-2027 · $50/hr\nFocus: AI/ML · Posted: 2026-07-19\nhttps://careers.example.test/2' });
    expect(byTitle.get('Backend Engineering Intern')).toMatchObject({ title: 'Backend Engineering — Acme', body: 'Austin, TX · summer-2027 · $50/hr\nFocus: Backend/API · Posted: 2026-07-19\nhttps://careers.example.test/3' });
  });
});
