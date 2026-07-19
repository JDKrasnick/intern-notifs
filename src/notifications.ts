import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { score } from './core/normalize.js';
import type { Internship } from './types.js';
import type { InternshipStore } from './store.js';

export const rankInternships = (jobs: Internship[]) => [...jobs].sort((a, b) => score(b.company, b.compensation) - score(a.company, a.compensation) || (b.sourceReferences[0]?.postedAt ?? '').localeCompare(a.sourceReferences[0]?.postedAt ?? '') || b.firstSeenAt.localeCompare(a.firstSeenAt));

export interface PushMessage { title: string; body: string; click?: string; }
export interface PushPublisher { publish(message: PushMessage): Promise<void>; }

export class NtfyPublisher implements PushPublisher {
  constructor(private readonly topic: string, private readonly endpoint = 'https://ntfy.sh', private readonly fetcher: typeof fetch = fetch) {}
  async publish(message: PushMessage) {
    const response = await this.fetcher(this.endpoint.replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: this.topic, title: message.title, message: message.body, priority: 4, tags: ['briefcase'], ...(message.click ? { click: message.click } : {}) })
    });
    if (!response.ok) throw new Error(`ntfy rejected notification with HTTP ${response.status}`);
  }
}

export interface PushTemplates { titleTemplate?: string; descriptionTemplate?: string; roleAbbreviations?: Record<string, string>; }
export const defaultRoleAbbreviations: Record<string, string> = {
  'software development engineer': 'SDE',
  'software engineering': 'SWE',
  'software engineer': 'SWE',
  'machine learning': 'ML',
  'artificial intelligence': 'AI',
  'data science': 'DS',
  'product management': 'PM',
  quantitative: 'Quant'
};
export const defaultPushTemplates: Required<PushTemplates> = {
  titleTemplate: '{shortTitle} — {company}',
  descriptionTemplate: '{location} · {season}{compensationDetail}\n{url}',
  roleAbbreviations: defaultRoleAbbreviations
};

function displayValue(value: string | undefined) { return (value ?? '').replace(/[\r\n\t]+/g, ' ').trim(); }
function safeClick(url: string) { try { const parsed = new URL(url); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined; } catch { return undefined; } }
function escapedPattern(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function compactRoleTitle(title: string, roleAbbreviations: Record<string, string> = defaultRoleAbbreviations) {
  let result = displayValue(title);
  for (const [source, replacement] of Object.entries(roleAbbreviations).sort(([left], [right]) => right.length - left.length)) result = result.replace(new RegExp(`\\b${escapedPattern(source)}\\b`, 'gi'), displayValue(replacement));
  return result.replace(/\b(internship|intern|co-op)\b/gi, '').replace(/[\s–—-]+$/g, '').replace(/\s{2,}/g, ' ').trim() || displayValue(title);
}
export function renderPushTemplate(template: string, job: Internship, roleAbbreviations: Record<string, string> = defaultRoleAbbreviations) {
  const compensation = displayValue(job.compensation.raw) || (job.compensation.maxHourlyUSD ? `$${job.compensation.maxHourlyUSD.toFixed(0)}/hr` : '');
  const values: Record<string, string> = {
    title: displayValue(job.title), shortTitle: compactRoleTitle(job.title, roleAbbreviations), company: displayValue(job.company), location: displayValue(job.location), season: displayValue(job.season), compensation, compensationDetail: compensation ? ` · ${compensation}` : '', url: safeClick(job.applyUrl) ?? ''
  };
  return template.replace(/\{(title|shortTitle|company|location|season|compensation|compensationDetail|url)\}/g, (_, key: string) => values[key] ?? '').trim();
}
function pushMessage(job: Internship, templates: PushTemplates): PushMessage {
  const aliases = { ...defaultRoleAbbreviations, ...(templates.roleAbbreviations ?? {}) };
  const title = renderPushTemplate(templates.titleTemplate ?? defaultPushTemplates.titleTemplate, job, aliases).replace(/[\r\n]+/g, ' ').slice(0, 180);
  return { title: title || 'New internship', body: renderPushTemplate(templates.descriptionTemplate ?? defaultPushTemplates.descriptionTemplate, job, aliases), click: safeClick(job.applyUrl) };
}
export function summaryChunks(jobs: Internship[], limit = 1200): Internship[][] {
  const chunks: Internship[][] = []; let current: Internship[] = []; let length = 0;
  for (const job of jobs) { const itemLength = pushMessage(job, defaultPushTemplates).body.length + 2; if (current.length && length + itemLength > limit) { chunks.push(current); current = []; length = 0; } current.push(job); length += itemLength; }
  if (current.length) chunks.push(current); return chunks;
}

export async function sendPendingNotifications(store: InternshipStore, publisher: PushPublisher, templates: PushTemplates = defaultPushTemplates, now: () => Date = () => new Date()): Promise<{ sent: number; failed: number }> {
  const jobs = rankInternships(await store.pendingSms()); let sent = 0; let failed = 0;
  for (const job of jobs.slice(0, 5)) {
    try { await publisher.publish(pushMessage(job, templates)); await store.markSmsSent(job.jobId, now().toISOString()); sent += 1; }
    catch { failed += 1; }
  }
  for (const chunk of summaryChunks(jobs.slice(5))) {
    const aliases = { ...defaultRoleAbbreviations, ...(templates.roleAbbreviations ?? {}) };
    try { await publisher.publish({ title: `${chunk.length} new internships`, body: chunk.map((job) => `${renderPushTemplate(templates.titleTemplate ?? defaultPushTemplates.titleTemplate, job, aliases)}\n${renderPushTemplate(templates.descriptionTemplate ?? defaultPushTemplates.descriptionTemplate, job, aliases)}`).join('\n\n') }); for (const job of chunk) await store.markSmsSent(job.jobId, now().toISOString()); sent += chunk.length; }
    catch { failed += chunk.length; }
  }
  return { sent, failed };
}

export interface EmailSender { send(subject: string, text: string, html: string): Promise<void>; }
export class SesEmailSender implements EmailSender {
  private readonly client = new SESv2Client({});
  constructor(private readonly from: string, private readonly to: string) {}
  async send(subject: string, text: string, html: string) {
    await this.client.send(new SendEmailCommand({ FromEmailAddress: this.from, Destination: { ToAddresses: [this.to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: html } } } } }));
  }
}

const escapeHtml = (input: string) => input.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);
export async function sendDigest(store: InternshipStore, sender: EmailSender, now: () => Date = () => new Date()): Promise<number> {
  const jobs = rankInternships(await store.pendingDigest()); if (!jobs.length) return 0;
  const text = jobs.map((job) => `${job.company} — ${job.title} (${job.location})\n${job.applyUrl}`).join('\n\n');
  const html = `<h1>Internship digest</h1><ul>${jobs.map((job) => `<li><strong>${escapeHtml(job.company)}</strong> — ${escapeHtml(job.title)} (${escapeHtml(job.location)})<br><a href="${escapeHtml(job.applyUrl)}">Apply</a></li>`).join('')}</ul>`;
  await sender.send(`Internship digest: ${jobs.length} new role${jobs.length === 1 ? '' : 's'}`, text, html);
  await store.markDigested(jobs.map((job) => job.jobId), now().toISOString());
  return jobs.length;
}
