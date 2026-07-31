import { SesEmailSender, type EmailSender } from './notifications.js';

type Checklist = {
  period: string;
  completed: number;
  total: number;
  complete: boolean;
  items: Array<{
    id: string;
    label: string;
    description: string;
    completion?: { completedAt: string; completedBy: string };
  }>;
};

type MonitoringOverview = {
  generatedAt: string;
  productionMetrics: {
    deadLetterMessages: number;
    failedExtractions24h: number;
    staleSources: number;
    quarantinedSources: number;
    pausedSources: number;
    activeAlarms: number;
    queuedMessages: number;
    processingMessages: number;
  };
  checklist: Checklist;
};

export interface MonitoringReminderDependencies {
  operationsApiUrl: string;
  operationsKey: string;
  dashboardUrl: string;
  emailSender: EmailSender;
  fetcher?: typeof fetch;
}

const escapeHtml = (input: string) => input.replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
})[character] ?? character);

export function createMonitoringReminderHandler(dependencies: MonitoringReminderDependencies) {
  return async () => {
    const response = await (dependencies.fetcher ?? fetch)(
      `${dependencies.operationsApiUrl.replace(/\/$/, '')}/operations/sources`,
      {
        headers: {
          'X-Operations-Key': dependencies.operationsKey,
          Accept: 'application/json',
        },
      },
    );
    if (!response.ok) throw new Error(`Monitoring overview returned ${response.status}.`);
    const overview = await response.json() as MonitoringOverview;
    if (overview.checklist.complete) {
      console.log(JSON.stringify({
        event: 'monitoring_reminder_skipped',
        period: overview.checklist.period,
        reason: 'monthly_checklist_complete',
      }));
      return { sent: false, period: overview.checklist.period, pending: 0 };
    }

    const pending = overview.checklist.items.filter((item) => !item.completion);
    const metrics = overview.productionMetrics;
    const metricLines = [
      `Dead-letter messages: ${metrics.deadLetterMessages}`,
      `Failed extractions (24h): ${metrics.failedExtractions24h}`,
      `Stale sources: ${metrics.staleSources}`,
      `Quarantined sources: ${metrics.quarantinedSources}`,
      `Paused sources: ${metrics.pausedSources}`,
      `Active alarms: ${metrics.activeAlarms}`,
      `Queue: ${metrics.queuedMessages} waiting, ${metrics.processingMessages} processing`,
    ];
    const text = [
      `InternNotifs monitoring — ${overview.checklist.period}`,
      '',
      ...metricLines,
      '',
      `${pending.length} of ${overview.checklist.total} monthly checks remain:`,
      ...pending.map((item) => `- ${item.label}: ${item.description}`),
      '',
      `Open the shared monitoring pane: ${dependencies.dashboardUrl}`,
    ].join('\n');
    const html = [
      `<h1>InternNotifs monitoring — ${escapeHtml(overview.checklist.period)}</h1>`,
      '<h2>Production now</h2>',
      `<ul>${metricLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
      `<h2>${pending.length} of ${overview.checklist.total} monthly checks remain</h2>`,
      `<ul>${pending.map((item) => `<li><strong>${escapeHtml(item.label)}</strong><br>${escapeHtml(item.description)}</li>`).join('')}</ul>`,
      `<p><a href="${escapeHtml(dependencies.dashboardUrl)}">Open the shared monitoring pane</a></p>`,
    ].join('');
    const attention = metrics.deadLetterMessages + metrics.failedExtractions24h + metrics.staleSources + metrics.quarantinedSources + metrics.activeAlarms;
    await dependencies.emailSender.send(
      `[InternNotifs] ${pending.length} monitoring checks pending${attention ? ` · ${attention} signals need review` : ''}`,
      text,
      html,
    );
    console.log(JSON.stringify({
      event: 'monitoring_reminder_sent',
      period: overview.checklist.period,
      pending: pending.length,
      attentionSignals: attention,
    }));
    return { sent: true, period: overview.checklist.period, pending: pending.length, attentionSignals: attention };
  };
}

const operationsApiUrl = process.env.OPERATIONS_API_URL;
const operationsKey = process.env.OPERATIONS_API_KEY;
const emailAddress = process.env.MONITORING_EMAIL_ADDRESS;
const dashboardUrl = process.env.MONITORING_DASHBOARD_URL ?? 'https://monitoring.jdkrasnick.com';

export const handler = async () => {
  if (!operationsApiUrl || !operationsKey || !emailAddress) {
    throw new Error('Monitoring reminder is not configured.');
  }
  return createMonitoringReminderHandler({
    operationsApiUrl,
    operationsKey,
    dashboardUrl,
    emailSender: new SesEmailSender(emailAddress, emailAddress),
  })();
};
