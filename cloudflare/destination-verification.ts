import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import { createHash } from 'node:crypto';
import { evaluateCatalogAdmission, deriveCanonicalAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination } from '../src/destination-verification.js';
import type { DestinationVerificationRequest } from '../src/destination-verification.js';
import type { ApplicationPageEvidence } from '../src/core/application-url.js';
import { reachabilityFromFailure, type Reachability } from '../src/core/application-verification.js';
import type { CatalogAdmissionReason, Internship, ProcessedListing, ProviderIdentity, SourceOccurrence } from '../src/types.js';
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

export function reachabilityFromHttpStatus(status: number | undefined): Reachability {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403 || status === 429) return 'blocked';
  if (status !== undefined && status >= 500) return 'unreachable';
  return 'live';
}

function incidentState(reason: CatalogAdmissionReason): 'open' | 'quarantined' {
  return ['destination-grace', 'destination-unresolved', 'destination-blocked-uninspectable'].includes(reason)
    ? 'open'
    : 'quarantined';
}

export async function persistDestinationAdmission(input: {
  jobs: D1InternshipStore;
  operations: D1CatalogAdmissionStore;
  message: DestinationVerificationMessage;
  job: Internship;
  reference: SourceOccurrence;
  reachability: Reachability;
  inspectedAt: string;
  evidence?: ApplicationPageEvidence;
  browserVisible?: boolean;
}): Promise<{
  destination: ReturnType<typeof classifyDestination>;
  incident?: { sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' };
}> {
  const { jobs, operations, message, job, reference, reachability, inspectedAt, evidence, browserVisible } = input;
  const mappedEmployer = await operations.resolveCanonicalEmployer(message.providerIdentity);
  const listing: ProcessedListing = {
    ...reference,
    externalId: message.externalId,
    fetchedAt: inspectedAt,
    providerIdentity: message.providerIdentity,
    postingIdentity: job.postingIdentity,
    employerEvidence: {
      authority: reference.provenance === 'reviewed-community' ? 'source-row' : 'reviewed-registry',
      ...(mappedEmployer ? { canonicalEmployer: mappedEmployer }
        : reference.admission?.canonicalEmployer ? { canonicalEmployer: reference.admission.canonicalEmployer }
          : job.admission?.canonicalEmployer ? { canonicalEmployer: job.admission.canonicalEmployer } : {}),
    },
    metadataCompleteness: reference.admission?.metadata ?? metadataCompleteness({ title: reference.title, locations: reference.locations ?? [reference.location] }),
  };
  const rule = await operations.resolveReviewRule(message.providerIdentity, message.candidateUrl);
  const destination = classifyDestination({ listing, reachability, ...(evidence ? { evidence } : {}), inspectedAt,
    ...(browserVisible !== undefined ? { browserVisible } : {}), ...(rule ? { rule } : {}) });
  const admission = evaluateCatalogAdmission({
    listing, destination,
    postingAttributed: reference.provenance !== 'reviewed-community' || reference.admission?.postingAttribution === 'attributed',
    evaluatedAt: inspectedAt, previous: reference.admission ?? job.admission,
  });
  const sourceReferences = job.sourceReferences.map((item) => item === reference ? { ...item, admission } : item);
  const occurrence = (await jobs.getSourceOccurrences(message.sourceId)).find((item) => item.externalId === message.externalId);
  await jobs.putAdmissionState(
    { ...job, sourceReferences, admission: deriveCanonicalAdmission(sourceReferences, inspectedAt) },
    occurrence ? { ...occurrence, occurrence: { ...occurrence.occurrence, admission }, changedAt: inspectedAt } : undefined,
  );

  const reason = admission.reasonCodes[0];
  await operations.resolveIncidents(message.jobId, message.sourceId, inspectedAt, reason);
  if (!reason) return { destination };
  const id = incidentId(message, reason);
  const state = incidentState(reason);
  const host = new URL(message.candidateUrl).hostname;
  await operations.upsertIncident({ id, jobId: message.jobId, sourceId: message.sourceId, host, reasonCode: reason,
    state, openedAt: inspectedAt, updatedAt: inspectedAt, ...(admission.graceDeadline ? { graceDeadline: admission.graceDeadline } : {}) });
  return { destination, incident: { sourceId: message.sourceId, host, reason, incidentId: id,
    messageType: state === 'open' ? 'incident-opened' : 'quarantine' } };
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
        let reachability: Reachability = 'live';
        let evidence: ApplicationPageEvidence | undefined;
        let browserError: unknown;
        try {
          const response = await page.goto(message.candidateUrl, { waitUntil: 'networkidle0', timeout: 20_000 });
          reachability = reachabilityFromHttpStatus(response?.status());
          if (reachability === 'live') {
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
            evidence = {
              ...browserEvidence,
              expectedPostingId: message.providerIdentity.postingId,
              confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] },
            };
          }
        } catch (error) {
          browserError = error;
          reachability = reachabilityFromFailure(error);
        } finally {
          await page.close();
        }
        const inspectedAt = now().toISOString();
        const result = await persistDestinationAdmission({ jobs, operations, message, job, reference, reachability, inspectedAt,
          ...(evidence ? { evidence, browserVisible: true } : {}) });
        if (result.incident) opened.push(result.incident);
        await operations.recordVerificationAttempt({ id: crypto.randomUUID(), jobId: message.jobId, sourceId: message.sourceId,
          candidateUrl: message.candidateUrl, state: browserError ? 'failed' : 'succeeded', classification: result.destination.classification,
          ...(browserError ? { error: browserError instanceof Error ? browserError.message.slice(0, 500) : String(browserError).slice(0, 500) } : {}),
          attemptedAt, completedAt: inspectedAt }, result.destination.evidenceHash ? { hash: result.destination.evidenceHash,
          classification: result.destination.classification, value: result.destination, observedAt: inspectedAt } : undefined);
        if (browserError && reachability !== 'gone') queued.retry({ delaySeconds: 86_400 });
        else queued.ack();
      } catch {
        queued.retry({ delaySeconds: 300 });
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
