import { describe, expect, it } from 'vitest';
import { ExpoPushPublisher, inspectExpoPushReceipts, sendNewJobNotifications } from '../src/notifications.js';
import { MemoryUserStore } from '../src/store.js';
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
    expect(await inspectExpoPushReceipts(users, publisher)).toEqual({ ok: 0, invalid: 1, pending: 0 });
    expect((await users.activeDevices()).find((device) => device.userId === 'eligible')).toBeUndefined();
  });

  it('records a transport failure as retryable error instead of leaving a receipt pending forever', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'android', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => new Response('unavailable', { status: 503 }));
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await users.pendingReceipts()).toEqual([]);
    expect((await users.getReceipt('eligible', 'job-1', 'ExponentPushToken[eligible]'))?.status).toBe('error');
  });

  it('treats an Expo success response without a ticket ID as retryable instead of permanently suppressing the alert', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'eligible', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'eligible', token: 'ExponentPushToken[eligible]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => new Response(JSON.stringify({ data: { status: 'ok' } }), { status: 200 }));
    expect(await sendNewJobNotifications([job], users, publisher)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect((await users.getReceipt('eligible', 'job-1', 'ExponentPushToken[eligible]'))?.status).toBe('error');
  });
});
