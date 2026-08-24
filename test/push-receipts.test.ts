import { describe, expect, it } from 'vitest';
import { ExpoPushPublisher, inspectExpoPushReceipts, retryExpoPushNotifications, sendNewJobNotifications } from '../src/notifications.js';
import { postingIdentityKey } from '../src/core/normalize.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship } from '../src/types.js';

const job: Internship = {
  jobId: 'job-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
  applyUrl: 'https://careers.example.test/job-1', normalizedUrl: 'https://careers.example.test/job-1', fingerprint: 'job-1', compensation: { raw: '' },
  sourceReferences: [], open: true, firstSeenAt: '2026-07-19T00:00:00.000Z', lastSeenAt: '2026-07-19T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
};

describe('Expo delivery lifecycle', () => {
  it('delivers only to opted-in matching users, avoids retry duplicates, and deactivates an invalid device after receipt reconciliation', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: { includeCategories: ['swe'] }, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putPreferences({ userId: 'disabled', filter: {}, alertsEnabled: false, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putPreferences({ userId: 'mismatch', filter: { includeCategories: ['quant'] }, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    for (const [userId, token] of [['eligible', 'ExponentPushToken[eligible]'], ['disabled', 'ExponentPushToken[disabled]'], ['mismatch', 'ExponentPushToken[mismatch]']] as const) {
      await users.putDevice({ userId, token, platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    }
    const calls: string[] = [];
    const publisher = new ExpoPushPublisher('https://push.example.test', async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/getReceipts')) return new Response(JSON.stringify({ data: { 'ticket-1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 });
      return new Response(JSON.stringify({ data: { id: 'ticket-1', status: 'ok' } }), { status: 200 });
    });

    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 1, skipped: 2, failed: 0 });
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 3, failed: 0 });
    expect(calls.filter((url) => url === 'https://push.example.test')).toHaveLength(1);
    expect(await inspectExpoPushReceipts(users, publisher)).toEqual({ ok: 0, invalid: 1, retryable: 0, pending: 0 });
    expect((await users.activeDevices()).find((device) => device.userId === 'eligible')).toBeUndefined();
  });

  it('retries an explicit transient HTTP rejection through the bounded retry path', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job);
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'android', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    let publishes = 0;
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => {
      publishes += 1;
      return publishes === 1
        ? new Response('unavailable', { status: 503 })
        : new Response(JSON.stringify({ data: { id: 'ticket-2', status: 'ok' } }), { status: 200 });
    });
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await users.getReceipt('eligible', postingIdentityKey(job.normalizedUrl), 'ExponentPushToken[eligible]')).toMatchObject({ status: 'retryable', attempts: 1, lastErrorCode: 'ExpoHttp503' });
    expect(await retryExpoPushNotifications(jobs, users, publisher)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(await users.getReceipt('eligible', postingIdentityKey(job.normalizedUrl), 'ExponentPushToken[eligible]')).toMatchObject({ status: 'pending', deliveryState: 'accepted', attempts: 2, ticketId: 'ticket-2' });
  });

  it('records an ambiguous connection failure as terminal unknown and never retries it', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'android', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => { throw new TypeError('connection reset'); });
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await users.getReceipt('eligible', postingIdentityKey(job.normalizedUrl), 'ExponentPushToken[eligible]')).toMatchObject({ status: 'pending', deliveryState: 'unknown', lastErrorCode: 'TransportAmbiguous' });
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('treats an Expo success response without a ticket ID as terminal unknown', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => new Response(JSON.stringify({ data: { status: 'ok' } }), { status: 200 }));
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await users.getReceipt('eligible', postingIdentityKey(job.normalizedUrl), 'ExponentPushToken[eligible]')).toMatchObject({ status: 'pending', deliveryState: 'unknown' });
  });

  it('atomically claims a delivery so overlapping workers send only once and logs the race safely', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    let publishes = 0;
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => { publishes += 1; await Promise.resolve(); return new Response(JSON.stringify({ data: { id: 'ticket-1', status: 'ok' } }), { status: 200 }); });
    const events: Array<{ event: string; recipientKey: string }> = [];
    const logger = (event: { event: string; recipientKey: string }) => { events.push(event); };

    const results = await Promise.all([
      sendNewJobNotifications([job], users, publisher, () => new Date('2026-08-14T00:00:00.000Z'), logger),
      sendNewJobNotifications([job], users, publisher, () => new Date('2026-08-14T00:00:00.000Z'), logger),
    ]);

    expect(publishes).toBe(1);
    expect(results.map((result) => result.sent).reduce((total, value) => total + value, 0)).toBe(1);
    expect(events.map((event) => event.event).sort()).toEqual(['notification_sent', 'notification_skipped_duplicate']);
    expect(JSON.stringify(events)).not.toContain('eligible');
    expect(JSON.stringify(events)).not.toContain('ExponentPushToken');
  });

  it('suppresses a second catalog job when provider URL aliases identify one posting', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    let publishes = 0;
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => { publishes += 1; return new Response(JSON.stringify({ data: { id: `ticket-${publishes}`, status: 'ok' } }), { status: 200 }); });
    const alias = { ...job, jobId: 'job-2', normalizedUrl: 'https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea/application?embed=true', applyUrl: 'https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea/application?embed=true' };
    const canonical = { ...job, jobId: 'job-3', normalizedUrl: 'https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea', applyUrl: 'https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea' };

    expect(await sendNewJobNotifications([alias], users, publisher, undefined, () => undefined)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(await sendNewJobNotifications([canonical], users, publisher, undefined, () => undefined)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(publishes).toBe(1);
  });
});
