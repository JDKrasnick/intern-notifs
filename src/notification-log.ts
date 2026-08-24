import { defaultPushTemplates, renderPushTemplate } from './notifications.js';
import { postingIdentity, roleFamilyFingerprint } from './core/normalize.js';
import type { DeliveryReceipt, Internship } from './types.js';

export interface NotificationLogOptions { since?: string; company?: string; limit?: number; }

export interface NotificationLogEntry {
  sentAt: string;
  status: DeliveryReceipt['status'];
  jobId: string;
  renderedTitle: string;
  company: string;
  title: string;
  location: string;
  season: string;
  normalizedUrl: string;
  sourceIds: string[];
}

/** Provider-aware enough for diagnostics; production identity remains deliberately conservative. */
export function canonicalNotificationUrl(value: string) {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === 'gh_jid' || key.toLowerCase() === 'embed' || key.toLowerCase().startsWith('utm_') || key.toLowerCase() === 'ref') url.searchParams.delete(key);
  }
  if (url.hostname === 'jobs.ashbyhq.com') url.pathname = url.pathname.replace(/\/application\/?$/i, '');
  if (url.hostname.endsWith('.myworkdayjobs.com')) url.pathname = url.pathname.toLowerCase();
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

function groups(entries: NotificationLogEntry[], key: (entry: NotificationLogEntry) => string) {
  const grouped = new Map<string, NotificationLogEntry[]>();
  for (const entry of entries) grouped.set(key(entry), [...(grouped.get(key(entry)) ?? []), entry]);
  return [...grouped.entries()].filter(([, values]) => values.length > 1).map(([identity, values]) => ({ identity, count: values.length, entries: values })).sort((left, right) => right.count - left.count || left.identity.localeCompare(right.identity));
}

export function buildNotificationLog(receipts: DeliveryReceipt[], jobs: Internship[], options: NotificationLogOptions = {}) {
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const company = options.company?.trim().toLowerCase();
  const entries = receipts
    .filter((receipt) => !options.since || receipt.createdAt >= options.since)
    .map((receipt): NotificationLogEntry | undefined => {
      const job = jobsById.get(receipt.jobId);
      if (!job || (company && !job.company.toLowerCase().includes(company))) return undefined;
      return {
        sentAt: receipt.createdAt,
        status: receipt.status,
        jobId: job.jobId,
        renderedTitle: renderPushTemplate(defaultPushTemplates.titleTemplate, job),
        company: job.company,
        title: job.title,
        location: job.location,
        season: job.season,
        normalizedUrl: job.normalizedUrl,
        sourceIds: [...new Set(job.sourceReferences.map((source) => source.sourceId))].sort(),
      };
    })
    .filter((entry): entry is NotificationLogEntry => Boolean(entry))
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt));
  const limited = entries.slice(0, options.limit ?? entries.length);
  const byStatus = Object.fromEntries(['pending', 'ok', 'error'].map((status) => [status, entries.filter((entry) => entry.status === status).length]));
  const byCompany = [...new Set(entries.map((entry) => entry.company))].map((name) => ({ company: name, count: entries.filter((entry) => entry.company === name).length })).sort((left, right) => right.count - left.count || left.company.localeCompare(right.company));
  return {
    summary: { matched: entries.length, returned: limited.length, byStatus, byCompany },
    duplicateApplications: groups(entries, (entry) => postingIdentity(entry.normalizedUrl)),
    repeatedRoleFamilies: groups(entries, (entry) => roleFamilyFingerprint(entry.company, entry.title, entry.season)),
    repeatedRenderedTitles: groups(entries, (entry) => entry.renderedTitle),
    entries: limited,
  };
}
