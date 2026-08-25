import { describe, expect, it } from 'vitest';
import { createMonitoringReminderHandler } from '../src/monitoring-reminder.js';

const overview = {
  generatedAt: '2026-07-30T20:00:00.000Z',
  productionMetrics: {
    deadLetterMessages: 2,
    failedExtractions24h: 3,
    staleSources: 1,
    quarantinedSources: 0,
    pausedSources: 1,
    activeAlarms: 1,
    queuedMessages: 4,
    processingMessages: 2,
    legacyPendingNotifications: 817,
  },
  checklist: {
    period: '2026-07',
    completed: 1,
    total: 2,
    complete: false,
    items: [
      { id: 'done', label: 'Done', description: 'Already checked.', completion: { completedAt: '2026-07-01T00:00:00.000Z', completedBy: 'owner' } },
      { id: 'pending', label: 'Pending check', description: 'Run the remaining check.' },
    ],
  },
};

describe('monitoring reminder', () => {
  it('emails one combined production summary while monthly checks remain', async () => {
    const messages: Array<{ subject: string; text: string; html: string }> = [];
    const handler = createMonitoringReminderHandler({
      operationsApiUrl: 'https://operations.test',
      operationsKey: 'secret',
      dashboardUrl: 'https://monitoring.example.com',
      fetcher: async () => Response.json(overview),
      emailSender: { async send(subject, text, html) { messages.push({ subject, text, html }); } },
    });

    await expect(handler()).resolves.toMatchObject({ sent: true, pending: 1, attentionSignals: 8 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toContain('1 monitoring checks pending');
    expect(messages[0]?.text).toContain('Dead-letter messages: 2');
    expect(messages[0]?.text).toContain('Failed extractions (24h): 3');
    expect(messages[0]?.text).toContain('Legacy notifications pending: 817');
    expect(messages[0]?.text).toContain('Pending check');
    expect(messages[0]?.html).toContain('https://monitoring.example.com');
  });

  it('does not email after the monthly checklist is complete', async () => {
    let sent = false;
    const handler = createMonitoringReminderHandler({
      operationsApiUrl: 'https://operations.test',
      operationsKey: 'secret',
      dashboardUrl: 'https://monitoring.example.com',
      fetcher: async () => Response.json({ ...overview, checklist: { ...overview.checklist, complete: true } }),
      emailSender: { async send() { sent = true; } },
    });

    await expect(handler()).resolves.toMatchObject({ sent: false, pending: 0 });
    expect(sent).toBe(false);
  });

  it('labels unavailable alarm telemetry without counting it as healthy or alarming', async () => {
    const messages: Array<{ text: string }> = [];
    const handler = createMonitoringReminderHandler({
      operationsApiUrl: 'https://operations.test',
      operationsKey: 'secret',
      dashboardUrl: 'https://monitoring.example.com',
      fetcher: async () => Response.json({
        ...overview,
        productionMetrics: { ...overview.productionMetrics, activeAlarms: null, processingMessages: null },
      }),
      emailSender: { async send(_subject, text) { messages.push({ text }); } },
    });

    await expect(handler()).resolves.toMatchObject({ sent: true, attentionSignals: 7 });
    expect(messages[0]?.text).toContain('Active alarms: unavailable');
    expect(messages[0]?.text).toContain('unavailable processing');
  });
});
