import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { score } from './core/normalize.js';
import type { Internship } from './types.js';
import type { InternshipStore } from './store.js';

export const rankInternships = (jobs: Internship[]) => [...jobs].sort((a, b) => score(b.company, b.compensation) - score(a.company, a.compensation) || (b.sourceReferences[0]?.postedAt ?? '').localeCompare(a.sourceReferences[0]?.postedAt ?? '') || b.firstSeenAt.localeCompare(a.firstSeenAt));

export interface SmsPublisher { publish(message: string): Promise<void>; }
export class SnsSmsPublisher implements SmsPublisher {
  private readonly client = new SNSClient({});
  constructor(private readonly destination: string, private readonly originationNumber?: string) {}
  async publish(message: string) {
    await this.client.send(new PublishCommand({ PhoneNumber: this.destination, Message: message, MessageAttributes: this.originationNumber ? { 'AWS.SNS.SMS.OriginationNumber': { DataType: 'String', StringValue: this.originationNumber } } : undefined }));
  }
}

function smsLine(job: Internship): string { const pay = job.compensation.maxHourlyUSD ? ` · $${job.compensation.maxHourlyUSD.toFixed(0)}/hr` : ''; return `${job.company} — ${job.title} (${job.location})${pay}\n${job.applyUrl}`; }
export function summaryChunks(jobs: Internship[], limit = 1200): Internship[][] {
  const chunks: Internship[][] = []; let current: Internship[] = []; let length = 0;
  for (const job of jobs) { const itemLength = smsLine(job).length + 2; if (current.length && length + itemLength > limit) { chunks.push(current); current = []; length = 0; } current.push(job); length += itemLength; }
  if (current.length) chunks.push(current); return chunks;
}

export async function sendPendingSms(store: InternshipStore, publisher: SmsPublisher, now: () => Date = () => new Date()): Promise<{ sent: number; failed: number }> {
  const jobs = rankInternships(await store.pendingSms()); let sent = 0; let failed = 0;
  for (const job of jobs.slice(0, 5)) {
    try { await publisher.publish(`New internship: ${smsLine(job)}`); await store.markSmsSent(job.jobId, now().toISOString()); sent += 1; }
    catch { failed += 1; }
  }
  for (const chunk of summaryChunks(jobs.slice(5))) {
    try { await publisher.publish(`New internships (${chunk.length}):\n\n${chunk.map(smsLine).join('\n\n')}`); for (const job of chunk) await store.markSmsSent(job.jobId, now().toISOString()); sent += chunk.length; }
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
  const text = jobs.map((job) => smsLine(job)).join('\n\n');
  const html = `<h1>Internship digest</h1><ul>${jobs.map((job) => `<li><strong>${escapeHtml(job.company)}</strong> — ${escapeHtml(job.title)} (${escapeHtml(job.location)})<br><a href="${escapeHtml(job.applyUrl)}">Apply</a></li>`).join('')}</ul>`;
  await sender.send(`Internship digest: ${jobs.length} new role${jobs.length === 1 ? '' : 's'}`, text, html);
  await store.markDigested(jobs.map((job) => job.jobId), now().toISOString());
  return jobs.length;
}
