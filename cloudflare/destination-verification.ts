import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import { createHash } from 'node:crypto';
import { evaluateCatalogAdmission, deriveCanonicalAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination } from '../src/destination-verification.js';
import type { DestinationVerificationRequest } from '../src/destination-verification.js';
import type { ApplicationPageEvidence } from '../src/core/application-url.js';
import type { ProcessedListing, ProviderIdentity } from '../src/types.js';
import { D1CatalogAdmissionStore } from './catalog-admission-store.js';
import { D1InternshipStore } from './d1-store.js';
import type { D1Database, MessageBatch, Queue } from './types.js';

export interface DestinationVerificationMessage {
  version: 1;
  jobId: string;
  sourceId: string;
  externalId: string;
  providerIdentity: ProviderIdentity;
  candidateUrl: string;
  reason: 'first-sight' | 'url-change' | 'content-change' | 'daily-retry' | 'weekly-sample';
  queuedAt: string;
}

export interface DestinationVerificationEnvironment {
  DB: D1Database;
  DESTINATION_BROWSER: BrowserWorker;
  DESTINATION_VERIFICATION_QUEUE: Queue;
  RESEND_API_KEY?: string;
  ADMISSION_SUPPORT_RECIPIENT?: string;
}

export function destinationVerificationMessage(request: DestinationVerificationRequest, queuedAt = new Date().toISOString()): DestinationVerificationMessage {
  return { version: 1, ...request, queuedAt };
}

function incidentId(message: DestinationVerificationMessage, reason: string): string {
  return createHash('sha256').update(`${message.jobId}\0${message.sourceId}\0${reason}`).digest('hex').slice(0, 32);
}

function parseMessage(value: unknown): DestinationVerificationMessage {
  const message = value as Partial<DestinationVerificationMessage>;
  if (message?.version !== 1 || typeof message.jobId !== 'string' || typeof message.sourceId !== 'string'
    || typeof message.externalId !== 'string' || typeof message.candidateUrl !== 'string'
    || !message.providerIdentity || typeof message.providerIdentity !== 'object') throw new Error('Destination verification message is invalid');
  return message as DestinationVerificationMessage;
}

async function sendIncidentEmail(
  store: D1CatalogAdmissionStore,
  env: Pick<DestinationVerificationEnvironment, 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT'>,
  group: { sourceId: string; host: string; reason: string; incidents: string[] },
  messageType: 'incident-opened' | 'grace-warning' | 'quarantine',
  sentAt: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ADMISSION_SUPPORT_RECIPIENT) return false;
  const incidentIds = [...group.incidents].sort();
  const dedupeKey = createHash('sha256').update(`${messageType}\0${group.sourceId}\0${group.host}\0${group.reason}\0${incidentIds.join(',')}`).digest('hex');
  if (await store.emailDeliveryExists(dedupeKey)) return true;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': dedupeKey,
    },
    body: JSON.stringify({
      from: 'InternNotifs Operations <operations@internnotifs.dev>',
      to: [env.ADMISSION_SUPPORT_RECIPIENT],
      subject: `[InternNotifs] ${messageType}: ${group.host}`,
      text: `${group.incidents.length} catalog admission incident(s) for ${group.sourceId} on ${group.host}. Reason: ${group.reason}.`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  await store.recordEmailDelivery(dedupeKey, incidentIds[0]!, messageType, sentAt);
  return true;
}

export async function processDestinationVerificationBatch(
  batch: MessageBatch<unknown>,
  env: DestinationVerificationEnvironment,
  now = () => new Date(),
): Promise<void> {
  const jobs = new D1InternshipStore(env.DB);
  const operations = new D1CatalogAdmissionStore(env.DB);
  const opened: Array<{ sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' }> = [];
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch(env.DESTINATION_BROWSER);
    for (const queued of batch.messages) {
      const attemptedAt = now().toISOString();
      let message: DestinationVerificationMessage | undefined;
      try {
        message = parseMessage(queued.body);
        const job = await jobs.getJob(message.jobId);
        if (!job) { queued.ack(); continue; }
        const reference = job.sourceReferences.find((item) => item.sourceId === message!.sourceId && item.externalId === message!.externalId);
        if (!reference) { queued.ack(); continue; }
        const page = await browser.newPage();
        try {
          await page.goto(message.candidateUrl, { waitUntil: 'networkidle0', timeout: 20_000 });
          const browserEvidence = await page.evaluate((expectedPostingId) => {
            const html = document.documentElement.outerHTML;
            const jobPostingCount = [...document.querySelectorAll('script[type="application/ld+json"]')].reduce((total, node) => total + ((node.textContent?.match(/["']@type["']\s*:\s*["']JobPosting["']/gi) ?? []).length), 0);
            const description = document.querySelector('meta[name="description"],meta[property="og:description"]')?.getAttribute('content') ?? undefined;
            const main = (document.querySelector('main')?.textContent ?? document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 12_000);
            return {
              url: location.href, title: document.title || undefined, description,
              postingIdPresent: expectedPostingId ? html.includes(expectedPostingId) : undefined,
              jobPostingCount,
              applicationFormPresent: Boolean(document.querySelector('form[action*="apply" i],form[id*="apply" i],input[type="file"],input[name="resume" i],input[name="cv" i]')),
              contentExcerpt: main || undefined,
            };
          }, message.providerIdentity.postingId);
          const evidence: ApplicationPageEvidence = {
            ...browserEvidence,
            expectedPostingId: message.providerIdentity.postingId,
            confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] },
          };
          const listing: ProcessedListing = {
            ...reference,
            externalId: message.externalId,
            fetchedAt: attemptedAt,
            providerIdentity: message.providerIdentity,
            postingIdentity: job.postingIdentity,
            employerEvidence: {
              authority: reference.provenance === 'reviewed-community' ? 'source-row' : 'reviewed-registry',
              ...(reference.admission?.canonicalEmployer ? { canonicalEmployer: reference.admission.canonicalEmployer } : job.admission?.canonicalEmployer ? { canonicalEmployer: job.admission.canonicalEmployer } : {}),
            },
            metadataCompleteness: reference.admission?.metadata ?? metadataCompleteness({ title: reference.title, locations: reference.locations ?? [reference.location] }),
          };
          const inspectedAt = now().toISOString();
          const destination = classifyDestination({ listing, reachability: 'live', evidence, inspectedAt, browserVisible: true });
          const admission = evaluateCatalogAdmission({
            listing, destination,
            postingAttributed: reference.provenance !== 'reviewed-community' || reference.admission?.postingAttribution === 'attributed',
            evaluatedAt: inspectedAt, previous: reference.admission ?? job.admission,
          });
          const sourceReferences = job.sourceReferences.map((item) => item === reference ? { ...item, admission } : item);
          await jobs.putInternship({ ...job, sourceReferences, admission: deriveCanonicalAdmission(sourceReferences, inspectedAt) });
          const occurrence = (await jobs.getSourceOccurrences(message.sourceId)).find((item) => item.externalId === message!.externalId);
          if (occurrence) await jobs.putSourceOccurrence({ ...occurrence, occurrence: { ...occurrence.occurrence, admission }, changedAt: inspectedAt });
          const reason = admission.reasonCodes[0];
          if (reason) {
            const id = incidentId(message, reason);
            const host = new URL(message.candidateUrl).hostname;
            await operations.upsertIncident({ id, jobId: message.jobId, sourceId: message.sourceId, host, reasonCode: reason,
              state: admission.catalogEligible ? 'resolved' : admission.graceDeadline ? 'open' : 'quarantined',
              openedAt: attemptedAt, updatedAt: inspectedAt, ...(admission.graceDeadline ? { graceDeadline: admission.graceDeadline } : {}) });
            if (!admission.catalogEligible) opened.push({ sourceId: message.sourceId, host, reason, incidentId: id,
              messageType: admission.graceDeadline ? 'incident-opened' : 'quarantine' });
          }
          await operations.recordVerificationAttempt({ id: crypto.randomUUID(), jobId: message.jobId, sourceId: message.sourceId,
            candidateUrl: message.candidateUrl, state: 'succeeded', classification: destination.classification,
            attemptedAt, completedAt: inspectedAt }, destination.evidenceHash ? { hash: destination.evidenceHash, classification: destination.classification, value: destination, observedAt: inspectedAt } : undefined);
          queued.ack();
        } finally {
          await page.close();
        }
      } catch (error) {
        const completedAt = now().toISOString();
        if (message) await operations.recordVerificationAttempt({ id: crypto.randomUUID(), jobId: message.jobId, sourceId: message.sourceId,
          candidateUrl: message.candidateUrl, state: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), attemptedAt, completedAt });
        queued.retry({ delaySeconds: 86_400 });
      }
    }
  } catch {
    for (const message of batch.messages) message.retry({ delaySeconds: 300 });
  } finally {
    if (browser) await browser.close();
  }
  const groups = new Map<string, { sourceId: string; host: string; reason: string; incidents: string[]; messageType: 'incident-opened' | 'quarantine' }>();
  for (const item of opened) {
    const key = `${item.messageType}\0${item.sourceId}\0${item.host}\0${item.reason}`;
    const group = groups.get(key) ?? { sourceId: item.sourceId, host: item.host, reason: item.reason, incidents: [], messageType: item.messageType };
    group.incidents.push(item.incidentId); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const sentAt = now().toISOString();
    if (await sendIncidentEmail(operations, env, group, group.messageType, sentAt) && group.messageType === 'quarantine') {
      for (const id of group.incidents) await operations.markIncidentNotification(id, 'quarantine', sentAt);
    }
  }
}

export async function enqueueDueDestinationVerifications(
  env: Pick<DestinationVerificationEnvironment, 'DB' | 'DESTINATION_VERIFICATION_QUEUE' | 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT'>,
  now = new Date(),
): Promise<number> {
  const operations = new D1CatalogAdmissionStore(env.DB);
  const jobs = new D1InternshipStore(env.DB);
  const incidents = await operations.listActiveIncidents();
  let queued = 0;
  const warnings = new Map<string, { sourceId: string; host: string; reason: string; incidents: string[] }>();
  for (const incident of incidents) {
    if (!incident.graceDeadline || incident.warningSentAt) continue;
    const remaining = Date.parse(incident.graceDeadline) - now.getTime();
    if (remaining <= 0 || remaining > 24 * 60 * 60_000) continue;
    const key = `${incident.sourceId}\0${incident.host}\0${incident.reasonCode}`;
    const group = warnings.get(key) ?? { sourceId: incident.sourceId, host: incident.host, reason: incident.reasonCode, incidents: [] };
    group.incidents.push(incident.id); warnings.set(key, group);
  }
  for (const group of warnings.values()) {
    const sentAt = now.toISOString();
    if (await sendIncidentEmail(operations, env, group, 'grace-warning', sentAt)) {
      for (const id of group.incidents) await operations.markIncidentNotification(id, 'grace-warning', sentAt);
    }
  }
  for (const incident of incidents) {
    if (Date.parse(incident.updatedAt) > now.getTime() - 23 * 60 * 60_000) continue;
    const job = await jobs.getJob(incident.jobId);
    const reference = job?.sourceReferences.find((item) => item.sourceId === incident.sourceId && item.externalId);
    const destination = reference?.admission?.destination ?? job?.admission?.destination;
    if (!job || !reference?.externalId || !destination) continue;
    const providerIdentity: ProviderIdentity = {
      provider: destination.provider,
      sourceId: incident.sourceId,
      sourceUrl: reference.sourceUrl,
      ...(destination.tenant ? { tenant: destination.tenant } : {}),
      ...(destination.expectedPostingId ? { postingId: destination.expectedPostingId } : {}),
    };
    await env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage({
      jobId: incident.jobId, sourceId: incident.sourceId, externalId: reference.externalId,
      providerIdentity, candidateUrl: destination.candidateUrl, reason: 'daily-retry',
    }, now.toISOString()));
    queued += 1;
  }
  const rules = await operations.listReviewRules();
  for (const rule of rules.filter((candidate) => !candidate.sampleDueAt || Date.parse(candidate.sampleDueAt) <= now.getTime())) {
    for (const candidate of await operations.reviewSampleCandidates(rule)) {
      await env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage({
        jobId: candidate.jobId, sourceId: candidate.sourceId, externalId: candidate.externalId,
        providerIdentity: { provider: rule.provider, sourceId: candidate.sourceId, sourceUrl: candidate.sourceUrl,
          ...(rule.tenant ? { tenant: rule.tenant } : {}), ...(candidate.expectedPostingId ? { postingId: candidate.expectedPostingId } : {}) },
        candidateUrl: candidate.candidateUrl, reason: 'weekly-sample',
      }, now.toISOString()));
      queued += 1;
    }
    await operations.markReviewRuleSampled(rule.id, new Date(now.getTime() + 7 * 86_400_000).toISOString());
  }
  return queued;
}
