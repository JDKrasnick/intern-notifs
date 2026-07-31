import type { MonitoringChecklist, MonitoringChecklistItemId } from './types.js';

export const monitoringChecklistItems: ReadonlyArray<{
  id: MonitoringChecklistItemId;
  label: string;
  description: string;
}> = [
  {
    id: 'review-fleet-health',
    label: 'Review fleet health',
    description: 'Review stale, paused, degraded, and quarantined sources across both providers.',
  },
  {
    id: 'inspect-failed-extractions',
    label: 'Inspect failed extractions',
    description: 'Review failed or rejected Greenhouse and Lever runs from the last 24 hours.',
  },
  {
    id: 'confirm-dead-letter-queues',
    label: 'Confirm dead-letter queues',
    description: 'Confirm both provider dead-letter queues are empty or every message is understood.',
  },
  {
    id: 'exercise-greenhouse-recovery',
    label: 'Exercise Greenhouse recovery',
    description: 'Pause, resume, and replay one Greenhouse shadow source and confirm a trusted snapshot.',
  },
  {
    id: 'exercise-lever-recovery',
    label: 'Exercise Lever recovery',
    description: 'Pause, resume, and replay one Lever shadow source and confirm a trusted snapshot.',
  },
  {
    id: 'verify-reminder-delivery',
    label: 'Verify reminder delivery',
    description: 'Confirm the combined Monday digest reaches the expected inbox and links to this pane.',
  },
  {
    id: 'confirm-nightly-contract',
    label: 'Confirm nightly live contract',
    description: 'Review the latest bounded live provider-contract run for both enabled regions.',
  },
];

export function monitoringPeriod(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Could not resolve monitoring period.');
  return `${year}-${month}`;
}

export function publicMonitoringChecklist(checklist: MonitoringChecklist | undefined, period: string) {
  const completions = checklist?.completions ?? {};
  const items = monitoringChecklistItems.map((item) => ({
    ...item,
    completion: completions[item.id],
  }));
  const completed = items.filter((item) => item.completion).length;
  return {
    period,
    items,
    completed,
    total: items.length,
    complete: completed === items.length,
    updatedAt: checklist?.updatedAt,
  };
}
