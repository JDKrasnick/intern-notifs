import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { ExpoPushPublisher, sendDigest, sendNewJobNotifications, type PushMessage } from '../src/notifications.js';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship, RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const at = (value: string) => () => new Date(value);
const role = (row: number, company: string, title: string, location: string, applyUrl: string): RawListing => ({
  sourceId: 'primary', document: 'README.md', sourceUrl: 'https://github.com/example/internships', row, company, title, location,
  season: 'summer-2027', applyUrl, compensation: { raw: '$50/hr', maxHourlyUSD: 50 }, state: 'open', postedAt: '2026-07-19', fetchedAt: '2026-07-19T08:00:00.000Z',
});
class Adapter implements SourceAdapter {
  constructor(readonly id: string, private readonly listings: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId: this.id, listings: this.listings, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.listings.length, lastSuccessAt: '2026-07-19T12:00:00.000Z' } };
  }
}
function event(userId: string | undefined, method: string, rawPath: string, body?: unknown, queryStringParameters?: Record<string, string>) {
  return { rawPath, queryStringParameters, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) } };
}
const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

describe('a full day of internship discovery', () => {
  it('keeps catalog, alerts, application tracking, and digest results coherent from morning seed through end of day', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore();
    const morning = [
      role(1, 'Northstar', 'Software Engineering Intern', 'New York, NY', 'https://careers.example.test/northstar/swe'),
      role(2, 'QuantCo', 'Quantitative Research Intern', 'Chicago, IL', 'https://careers.example.test/quantco/research'),
      role(3, 'BrandCo', 'Marketing Intern', 'Remote', 'https://careers.example.test/brandco/marketing'),
    ];
    // Morning startup learns the existing catalog without waking every student.
    const seed = await new Poller([new Adapter('primary', morning), new Adapter('secondary', [])], jobs, at('2026-07-19T08:00:00.000Z')).poll();
    expect(seed).toMatchObject({ baselineSources: ['primary', 'secondary'], newJobs: [] });
    expect(await jobs.pendingSms()).toEqual([]);

    await users.putPreferences({ userId: 'ada', filter: { includeCategories: ['swe', 'ai-ml'] }, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T08:30:00.000Z' });
    await users.putPreferences({ userId: 'quinn', filter: { includeCategories: ['quant'] }, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T08:30:00.000Z' });
    await users.putPreferences({ userId: 'quiet', filter: {}, alertsEnabled: false, onboardingComplete: true, updatedAt: '2026-07-19T08:30:00.000Z' });
    for (const [userId, token] of [['ada', 'ExponentPushToken[ada]'], ['quinn', 'ExponentPushToken[quinn]'], ['quiet', 'ExponentPushToken[quiet]']] as const) {
      await users.putDevice({ userId, token, platform: 'ios', active: true, createdAt: '2026-07-19T08:30:00.000Z', updatedAt: '2026-07-19T08:30:00.000Z' });
    }

    const midday = [...morning,
      role(4, 'Northstar', 'Full Stack Software Engineering Intern', 'New York, NY', 'https://careers.example.test/northstar/full-stack'),
      role(5, 'ModelWorks', 'Machine Learning Intern', 'Remote (US)', 'https://careers.example.test/modelworks/ml'),
      role(6, 'QuantCo', 'Quantitative Trading Intern', 'New York, NY', 'https://careers.example.test/quantco/trading'),
    ];
    const secondaryCopies = [
      role(7, 'Northstar, Inc.', 'Full Stack Software Engineer Intern', 'NYC', 'https://boards.example.test/northstar/full-stack'),
      role(8, 'ModelWorks Incorporated', 'Machine Learning Internship', 'Remote US', 'https://boards.example.test/modelworks/ml'),
      role(9, 'QuantCo Corp.', 'Quantitative Trading Internship', 'New York City', 'https://boards.example.test/quantco/trading'),
    ].map((listing) => ({ ...listing, sourceId: 'secondary', document: 'OFFSEASON.md' }));
    const discovered = await new Poller([new Adapter('primary', midday), new Adapter('secondary', secondaryCopies)], jobs, at('2026-07-19T12:00:00.000Z')).poll();
    expect(discovered.failures).toEqual([]);
    expect(discovered.newJobs.map((job) => job.title).sort()).toEqual(['Full Stack Software Engineering Intern', 'Machine Learning Intern', 'Quantitative Trading Intern']);
    expect(jobs.jobs.size).toBe(6); // Five technical roles plus the retained non-technical source row.
    expect([...jobs.jobs.values()].find((job) => job.title === 'Machine Learning Intern')?.sourceReferences).toHaveLength(2);

    const sentPayloads: Array<{ to: string; title: string; body: string; data: { jobId: string } }> = [];
    const publisher = new ExpoPushPublisher('https://push.example.test', async (_url, init) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as { to: string; title: string; body: string; data: { jobId: string } });
      return new Response(JSON.stringify({ data: { id: `ticket-${sentPayloads.length}`, status: 'ok' } }), { status: 200 });
    });
    expect(await sendNewJobNotifications(discovered.newJobs, users, publisher, at('2026-07-19T12:01:00.000Z'))).toEqual({ sent: 3, skipped: 6, failed: 0 });
    expect(sentPayloads.map((payload) => payload.to).sort()).toEqual(['ExponentPushToken[ada]', 'ExponentPushToken[ada]', 'ExponentPushToken[quinn]']);
    expect(sentPayloads.find((payload) => payload.body.includes('Remote (US)'))).toMatchObject({ title: 'ML — ModelWorks', body: expect.stringContaining('Remote (US) · summer-2027') });

    // This is the same contract used by the mobile feed, search, and notification tap handler.
    const api = createApiHandler({ jobs, users });
    const firstPage = json<{ jobs: Internship[]; cursor?: string }>(await api(event(undefined, 'GET', '/jobs', undefined, { limit: '2' })));
    const secondPage = json<{ jobs: Internship[]; cursor?: string }>(await api(event(undefined, 'GET', '/jobs', undefined, { limit: '2', cursor: firstPage.cursor! })));
    const thirdPage = json<{ jobs: Internship[] }>(await api(event(undefined, 'GET', '/jobs', undefined, { limit: '2', cursor: secondPage.cursor! })));
    const catalog = [...firstPage.jobs, ...secondPage.jobs, ...thirdPage.jobs];
    expect(catalog).toHaveLength(5);
    expect(catalog.some((job) => job.title === 'Marketing Intern')).toBe(false);
    expect(catalog.filter((job) => `${job.company} ${job.title} ${job.location}`.toLowerCase().includes('remote')).map((job) => job.title)).toEqual(['Machine Learning Intern']);
    const tappedId = sentPayloads.find((payload) => payload.body.includes('Remote (US)'))!.data.jobId;
    expect(json<Internship>(await api(event(undefined, 'GET', `/jobs/${tappedId}`)))).toMatchObject({ title: 'Machine Learning Intern', location: 'Remote (US)' });

    const saved = await api(event('ada', 'POST', '/me/applications', { jobId: tappedId, status: 'applied', notes: 'Applied after the push alert.' }));
    expect(saved.statusCode).toBe(201);
    expect(json<{ officialApplyUrl: string }>(saved).officialApplyUrl).toBe('https://careers.example.test/modelworks/ml');
    expect(json<{ applications: Array<{ jobId: string; status: string }> }>(await api(event('ada', 'GET', '/me/applications'))).applications).toMatchObject([{ jobId: tappedId, status: 'applied' }]);

    // A noon re-poll and scheduler retry must not produce duplicate catalog rows or device alerts.
    const noonRetry = await new Poller([new Adapter('primary', midday), new Adapter('secondary', secondaryCopies)], jobs, at('2026-07-19T12:10:00.000Z')).poll();
    expect(noonRetry.newJobs).toEqual([]);
    expect(jobs.jobs.size).toBe(6);
    expect(await sendNewJobNotifications(discovered.newJobs, users, publisher, at('2026-07-19T12:11:00.000Z'))).toEqual({ sent: 0, skipped: 9, failed: 0 });
    expect(sentPayloads).toHaveLength(3);

    const email: PushMessage & { subject?: string; html?: string } = { title: '', body: '' };
    expect(await sendDigest(jobs, { send: async (subject, text, html) => { email.subject = subject; email.body = text; email.html = html; } }, at('2026-07-19T17:00:00.000Z'))).toBe(3);
    expect(email).toMatchObject({ subject: 'Internship digest: 3 new roles', body: expect.stringContaining('Remote (US)') });
    expect(email.body).not.toContain('Marketing Intern');
    expect(await sendDigest(jobs, { send: async () => { throw new Error('a second digest should be empty'); } })).toBe(0);
  });
});
