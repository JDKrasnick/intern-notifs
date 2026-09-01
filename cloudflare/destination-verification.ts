import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import { createHash } from 'node:crypto';
import { evaluateCatalogAdmission, deriveCanonicalAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination, matchingBrowserDestination } from '../src/destination-verification.js';
import type { DestinationVerificationRequest } from '../src/destination-verification.js';
import type { ApplicationPageEvidence } from '../src/core/application-url.js';
import { reachabilityFromFailure, type Reachability } from '../src/core/application-verification.js';
import { normalizeUrl } from '../src/core/normalize.js';
import { combineRenderedFrameEvidence, type RenderedFrameSnapshot } from '../src/rendered-destination-evidence.js';
import type { CatalogAdmissionReason, Internship, ProcessedListing, ProviderIdentity, SourceOccurrence } from '../src/types.js';
import { D1CatalogAdmissionStore, destinationVerificationMatchesReference } from './catalog-admission-store.js';
import { D1InternshipStore } from './d1-store.js';
import type { D1Database, MessageBatch, Queue } from './types.js';

export interface DestinationVerificationMessage {
  version: 1;
  jobId: string;
  sourceId: string;
  externalId: string;
  providerIdentity: ProviderIdentity;
  candidateUrl: string;
  reason: 'first-sight' | 'url-change' | 'content-change' | 'daily-retry' | 'weekly-sample' | 'historical-backfill';
  queuedAt: string;
  occurrenceKey?: string;
  leaseToken?: string;
  idempotencyKey?: string;
  generationId?: string;
}

export interface DestinationVerificationEnvironment {
  DB: D1Database;
  DESTINATION_BROWSER: BrowserWorker;
  DESTINATION_VERIFICATION_QUEUE: Queue;
  RESEND_API_KEY?: string;
  ADMISSION_SUPPORT_RECIPIENT?: string;
  AUTH_FROM_EMAIL?: string;
}

const DESTINATION_RETRY_DELAY_SECONDS = 86_400;
const DESTINATION_RETRY_LEASE_MARGIN_MS = 60 * 60_000;

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

async function classifyReferenceDestination(input: {
  operations: D1CatalogAdmissionStore;
  message: DestinationVerificationMessage;
  job: Internship;
  reference: SourceOccurrence;
  reachability: Reachability;
  inspectedAt: string;
  evidence?: ApplicationPageEvidence;
  browserVisible?: boolean;
}): Promise<{ listing: ProcessedListing; destination: ReturnType<typeof classifyDestination> }> {
  const { operations, message, job, reference, reachability, inspectedAt, evidence, browserVisible } = input;
  const mappedEmployer = await operations.resolveCanonicalEmployer(message.providerIdentity);
  const mayReuseEmployer = reference.employerLabelOrigin !== 'inherited' || reference.employerInheritance === 'same-tenant';
  const listing: ProcessedListing = {
    ...reference,
    externalId: message.externalId,
    fetchedAt: inspectedAt,
    providerIdentity: message.providerIdentity,
    postingIdentity: job.postingIdentity,
    employerEvidence: {
      authority: reference.provenance === 'reviewed-community' ? 'source-row' : 'reviewed-registry',
      ...(mappedEmployer ? { canonicalEmployer: mappedEmployer }
        : mayReuseEmployer && reference.admission?.canonicalEmployer ? { canonicalEmployer: reference.admission.canonicalEmployer }
          : mayReuseEmployer && job.admission?.canonicalEmployer ? { canonicalEmployer: job.admission.canonicalEmployer } : {}),
    },
    metadataCompleteness: reference.admission?.metadata ?? metadataCompleteness({ title: reference.title, locations: reference.locations ?? [reference.location] }),
  };
  const rule = await operations.resolveReviewRule(message.providerIdentity, message.candidateUrl);
  return { listing, destination: classifyDestination({ listing, reachability, ...(evidence ? { evidence } : {}), inspectedAt,
    ...(browserVisible !== undefined ? { browserVisible } : {}), ...(rule ? { rule } : {}) }) };
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
  obsolete?: true;
  incident?: { sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' };
}> {
  const { jobs, operations, message, job, reference, reachability, inspectedAt, evidence, browserVisible } = input;
  const { listing, destination } = await classifyReferenceDestination({ operations, message, job, reference, reachability,
    inspectedAt, ...(evidence ? { evidence } : {}), ...(browserVisible !== undefined ? { browserVisible } : {}) });
  const admission = evaluateCatalogAdmission({
    listing, destination,
    postingAttributed: reference.provenance !== 'reviewed-community'
      || reference.admission?.postingAttribution === 'attributed'
      || (browserVisible === true && ['posting-detail', 'application-form'].includes(destination.classification)),
    evaluatedAt: inspectedAt, previous: reference.admission ?? job.admission,
  });
  const sourceReferences = job.sourceReferences.map((item) => item === reference ? { ...item, admission } : item);
  const occurrence = (await jobs.getSourceOccurrences(message.sourceId)).find((item) => item.externalId === message.externalId);
  const canonicalAdmission = deriveCanonicalAdmission(sourceReferences, inspectedAt);
  const authoritativeClosure = destination.classification === 'gone';
  const verifiedOpen = ['posting-detail', 'application-form'].includes(destination.classification)
    && canonicalAdmission?.catalogEligible && sourceReferences.some((item) => item.state === 'open');
  let normalizedCandidate = message.candidateUrl;
  try { normalizedCandidate = normalizeUrl(message.candidateUrl); } catch { /* Preserve the reviewed candidate verbatim if normalization fails. */ }
  const reopeningFromClosure = verifiedOpen && Boolean(job.invalidApplicationUrl);
  const proposedJob = { ...job, sourceReferences, admission: canonicalAdmission,
      ...(authoritativeClosure ? {
        open: false,
        applicationUrlValidatedAt: undefined,
        invalidApplicationUrl: normalizedCandidate,
        notification: { ...job.notification, smsPending: false, digestPending: false },
      } : reopeningFromClosure ? {
        open: true,
        applicationUrlValidatedAt: inspectedAt,
        invalidApplicationUrl: undefined,
      } : verifiedOpen ? { applicationUrlValidatedAt: inspectedAt }
        : canonicalAdmission?.alertEligible ? { applicationUrlValidatedAt: job.applicationUrlValidatedAt }
          : { applicationUrlValidatedAt: undefined }) };
  const proposedOccurrence = occurrence
    ? { ...occurrence, occurrence: { ...occurrence.occurrence, admission }, changedAt: inspectedAt }
    : undefined;
  const persisted = await jobs.putAdmissionState(proposedJob, reference, proposedOccurrence, occurrence);
  if (!persisted) return { destination, obsolete: true };

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
  env: Pick<DestinationVerificationEnvironment, 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  group: { sourceId: string; host: string; reason: string; incidents: string[] },
  messageType: 'incident-opened' | 'grace-warning' | 'quarantine',
  sentAt: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ADMISSION_SUPPORT_RECIPIENT || !env.AUTH_FROM_EMAIL) return false;
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
      from: env.AUTH_FROM_EMAIL,
      to: [env.ADMISSION_SUPPORT_RECIPIENT],
      subject: `[InternNotifs] ${messageType}: ${group.host}`,
      text: `${group.incidents.length} catalog admission incident(s) for ${group.sourceId} on ${group.host}. Reason: ${group.reason}.`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  await store.recordEmailDelivery(dedupeKey, incidentIds[0]!, messageType, sentAt);
  return true;
}

export async function sendAdmissionOperationalAlert(
  store: D1CatalogAdmissionStore,
  env: Pick<DestinationVerificationEnvironment, 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  input: { signals: string[]; details: string; observedAt: string },
): Promise<boolean> {
  if (!input.signals.length || !env.RESEND_API_KEY || !env.ADMISSION_SUPPORT_RECIPIENT || !env.AUTH_FROM_EMAIL) return false;
  const signals = [...new Set(input.signals)].sort();
  const day = input.observedAt.slice(0, 10);
  const dedupeKey = createHash('sha256').update(`operational-health\0${day}\0${signals.join(',')}`).digest('hex');
  if (await store.emailDeliveryExists(dedupeKey)) return true;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': dedupeKey },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [env.ADMISSION_SUPPORT_RECIPIENT],
      subject: `[InternNotifs] catalog admission health: ${signals.join(', ')}`,
      text: input.details,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  await store.recordEmailDelivery(dedupeKey, `operational:${day}`, 'operational-health', input.observedAt);
  return true;
}

export async function processDestinationVerificationBatch(
  batch: MessageBatch<unknown>,
  env: DestinationVerificationEnvironment,
  now = () => new Date(),
): Promise<void> {
  const jobs = new D1InternshipStore(env.DB);
  const operations = new D1CatalogAdmissionStore(env.DB);
  const settleWithoutVerification = async (
    queued: MessageBatch<unknown>['messages'][number],
    message: DestinationVerificationMessage,
    completedAt: string,
    classification: string,
    nextCheckAt = completedAt,
  ) => {
    if (message.occurrenceKey) await operations.completeScheduledVerification({ occurrenceKey: message.occurrenceKey,
      leaseToken: message.leaseToken, completedAt, classification, nextCheckAt });
    if (message.idempotencyKey) await operations.recordVerificationCompletion(message.idempotencyKey, completedAt);
    queued.ack();
  };
  const opened: Array<{ sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' }> = [];
  const pending: Array<{ queued: MessageBatch<unknown>['messages'][number]; message: DestinationVerificationMessage }> = [];
  const pendingAttemptKeys = new Set<string>();
  const batchStartedAt = now();
  const recentAttemptCutoff = new Date(batchStartedAt.getTime() - 24 * 60 * 60_000).toISOString();
  const nextAttemptAfterRecentDuplicate = new Date(batchStartedAt.getTime() + 24 * 60 * 60_000).toISOString();
  for (const queued of batch.messages) {
    try {
      const message = parseMessage(queued.body);
      if (message.idempotencyKey && await operations.verificationCompleted(message.idempotencyKey)) {
        queued.ack();
        continue;
      }
      const job = await jobs.getJob(message.jobId);
      if (!job) { queued.ack(); continue; }
      const reference = job.sourceReferences.find((item) => item.sourceId === message.sourceId && item.externalId === message.externalId);
      if (!reference) { queued.ack(); continue; }
      const candidateOnly = message.reason === 'historical-backfill';
      if (!candidateOnly && !destinationVerificationMatchesReference(reference, message)) {
        await settleWithoutVerification(queued, message, now().toISOString(), 'obsolete');
        continue;
      }
      const existing = candidateOnly ? undefined : matchingBrowserDestination(job, message, message.queuedAt);
      if (existing) {
        await settleWithoutVerification(queued, message, now().toISOString(), existing.classification, existing.nextCheckAt);
        continue;
      }
      const attemptKey = `${candidateOnly ? `backfill:${message.generationId ?? ''}:${message.occurrenceKey ?? ''}` : 'live'}\0${message.jobId}\0${message.sourceId}\0${message.candidateUrl}`;
      if (pendingAttemptKeys.has(attemptKey)) {
        queued.ack(); continue;
      }
      if (!candidateOnly
        && await operations.hasVerificationAttemptSince(message.jobId, message.sourceId, message.candidateUrl, recentAttemptCutoff)) {
        await settleWithoutVerification(queued, message, now().toISOString(),
          reference.admission?.destination.classification ?? 'recent-attempt', nextAttemptAfterRecentDuplicate);
        continue;
      }
      pendingAttemptKeys.add(attemptKey);
      pending.push({ queued, message });
    } catch {
      queued.retry({ delaySeconds: 300 });
    }
  }
  if (!pending.length) return;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch(env.DESTINATION_BROWSER);
    for (const { queued, message } of pending) {
      const attemptedAt = now().toISOString();
      try {
        if (message.idempotencyKey && await operations.verificationCompleted(message.idempotencyKey)) {
          queued.ack();
          continue;
        }
        const job = await jobs.getJob(message.jobId);
        if (!job) { queued.ack(); continue; }
        const reference = job.sourceReferences.find((item) => item.sourceId === message.sourceId && item.externalId === message.externalId);
        if (!reference) { queued.ack(); continue; }
        const candidateOnly = message.reason === 'historical-backfill';
        if (!candidateOnly && !destinationVerificationMatchesReference(reference, message)) {
          await settleWithoutVerification(queued, message, attemptedAt, 'obsolete');
          continue;
        }
        const existing = candidateOnly ? undefined : matchingBrowserDestination(job, message, message.queuedAt);
        if (existing) {
          await settleWithoutVerification(queued, message, attemptedAt, existing.classification, existing.nextCheckAt);
          continue;
        }
        const page = await browser.newPage();
        let reachability: Reachability = 'live';
        let evidence: ApplicationPageEvidence | undefined;
        let collisionJobIds: string[] = [];
        let browserError: unknown;
        try {
          const response = await page.goto(message.candidateUrl, { waitUntil: 'networkidle0', timeout: 20_000 });
          reachability = reachabilityFromHttpStatus(response?.status());
          if (reachability === 'live') {
            const renderedFrames: RenderedFrameSnapshot[] = [];
            let failedFrameCount = 0;
            for (const frame of page.frames()) {
              try {
                const snapshot = await frame.evaluate((requestedPostingId) => {
                  const visible = (element: Element) => element.getClientRects().length > 0;
                  const structuredPostings: Record<string, unknown>[] = [];
                  let jobPostingCount = 0;
                  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
                    const text = node.textContent ?? '';
                    const matches = text.match(/["']@type["']\s*:\s*["']JobPosting["']/gi) ?? [];
                    jobPostingCount += matches.length;
                    if (matches.length) {
                      try {
                        const queue: unknown[] = [JSON.parse(text)];
                        while (queue.length) {
                          const value = queue.shift();
                          if (Array.isArray(value)) { queue.push(...value); continue; }
                          if (!value || typeof value !== 'object') continue;
                          const record = value as Record<string, unknown>;
                          if (record['@graph']) queue.push(record['@graph']);
                          const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
                          if (types.includes('JobPosting')) structuredPostings.push(record);
                        }
                      } catch { /* Malformed structured data remains ordinary visible evidence. */ }
                    }
                  }
                  const pageUrl = new URL(location.href); pageUrl.hash = '';
                  const jobRoute = /(?:^|\/)(?:careers?|jobs?|openings?|positions?|roles?|vacancies?)(?:\/|$)/i;
                  const distinctJobLinks = new Set([...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
                    .filter(visible)
                    .map((link) => { try { const value = new URL(link.href, location.href); value.hash = ''; return value; } catch { return undefined; } })
                    .filter((value): value is URL => Boolean(value && ['http:', 'https:'].includes(value.protocol)
                      && value.toString() !== pageUrl.toString() && jobRoute.test(value.pathname)))
                    .map((value) => value.toString()));
                  const actionableApply = [...document.querySelectorAll<HTMLElement>('a[href],button')].some((control) => {
                    if (!visible(control) || !/^apply(?:\s+now)?$/iu.test(control.innerText.trim())) return false;
                    if (control instanceof HTMLButtonElement) return Boolean(control.closest('form'));
                    try {
                      const target = new URL((control as HTMLAnchorElement).href, location.href); target.hash = '';
                      return target.toString() !== pageUrl.toString();
                    } catch { return false; }
                  });
                  const description = document.querySelector('meta[name="description"],meta[property="og:description"]')?.getAttribute('content') ?? undefined;
                  const main = (document.querySelector('main')?.innerText ?? document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 12_000);
                  const escapedPostingId = requestedPostingId?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const matching = escapedPostingId ? structuredPostings.filter((record) => new RegExp(
                    `(?:^|[^a-z0-9])${escapedPostingId}(?:$|[^a-z0-9])`, 'i',
                  ).test(JSON.stringify(record))) : [];
                  const solePostingDeclaresIdentity = structuredPostings.length === 1
                    && ['identifier', '@id', 'url', 'jobId', 'postingId', 'requisitionId']
                      .some((key) => structuredPostings[0][key] !== undefined && structuredPostings[0][key] !== null);
                  const selectedPosting = matching.length === 1 ? matching[0]
                    : structuredPostings.length === 1 && (!requestedPostingId || !solePostingDeclaresIdentity)
                      ? structuredPostings[0] : undefined;
                  const selectedValidThrough = typeof selectedPosting?.validThrough === 'string'
                    && !Number.isNaN(Date.parse(selectedPosting.validThrough))
                    ? new Date(selectedPosting.validThrough).toISOString() : undefined;
                  return {
                    url: location.href, title: document.title || undefined, description,
                    visibleText: main || undefined,
                    structuredJobText: selectedPosting ? JSON.stringify(selectedPosting).slice(0, 40_000) : undefined,
                    validThrough: selectedValidThrough,
                    jobPostingCount, distinctJobLinkCount: distinctJobLinks.size,
                    applicationFormPresent: actionableApply || [...document.querySelectorAll<Element>(
                      'form[action*="apply" i],form[id*="apply" i],input[type="file"],input[name="resume" i],input[name="cv" i]',
                    )].some(visible),
                  };
                }, message.providerIdentity.postingId);
                renderedFrames.push({ ...snapshot, ...(frame.parentFrame() ? { parentUrl: frame.parentFrame()!.url() } : {}) });
              } catch {
                failedFrameCount += 1;
              }
            }
            evidence = combineRenderedFrameEvidence({ role: reference.title, expectedPostingId: message.providerIdentity.postingId,
              frames: renderedFrames, failedFrameCount });
            if (!candidateOnly && evidence?.renderedEvidenceHash && message.providerIdentity.postingId) {
              collisionJobIds = await operations.renderedEvidenceCollisionJobIds(
                message.jobId, evidence.renderedEvidenceHash, message.providerIdentity.postingId,
              );
              if (collisionJobIds.length) evidence = { ...evidence, identicalEvidenceForDifferentPosting: true };
            }
          }
        } catch (error) {
          browserError = error;
          reachability = reachabilityFromFailure(error);
        } finally {
          await page.close();
        }
        const inspectedAt = now().toISOString();
        let currentJob = job;
        let currentReference = reference;
        if (!candidateOnly) {
          const refreshedJob = await jobs.getJob(message.jobId);
          const refreshedReference = refreshedJob?.sourceReferences.find((item) => item.sourceId === message.sourceId
            && item.externalId === message.externalId);
          if (!refreshedJob || !refreshedReference || !destinationVerificationMatchesReference(refreshedReference, message)) {
            await settleWithoutVerification(queued, message, inspectedAt, 'obsolete');
            continue;
          }
          currentJob = refreshedJob;
          currentReference = refreshedReference;
        }
        for (const collisionJobId of message.reason === 'historical-backfill' ? [] : collisionJobIds) {
          const collisionJob = await jobs.getJob(collisionJobId);
          const collisionReference = collisionJob?.sourceReferences.find((item) => item.externalId
            && item.admission?.destination.renderedEvidenceHash === evidence?.renderedEvidenceHash);
          const prior = collisionReference?.admission?.destination;
          if (!collisionJob || !collisionReference?.externalId || !prior?.expectedPostingId) continue;
          const collisionMessage: DestinationVerificationMessage = {
            version: 1, jobId: collisionJob.jobId, sourceId: collisionReference.sourceId,
            externalId: collisionReference.externalId, candidateUrl: prior.candidateUrl, reason: 'weekly-sample', queuedAt: attemptedAt,
            providerIdentity: { provider: prior.provider, sourceId: collisionReference.sourceId, sourceUrl: collisionReference.sourceUrl,
              ...(prior.tenant ? { tenant: prior.tenant } : {}), postingId: prior.expectedPostingId },
          };
          const collisionResult = await persistDestinationAdmission({ jobs, operations, message: collisionMessage,
            job: collisionJob, reference: collisionReference, reachability: 'live', inspectedAt, browserVisible: true,
            evidence: { url: prior.finalUrl ?? prior.candidateUrl, expectedPostingId: prior.expectedPostingId,
              renderedEvidenceHash: prior.renderedEvidenceHash, identicalEvidenceForDifferentPosting: true,
              confidence: { score: 0, level: 'low', recommendation: 'review', signals: ['identical rendered evidence for different posting IDs'] } } });
          if (collisionResult.incident) opened.push(collisionResult.incident);
        }
        const result = candidateOnly
          ? await classifyReferenceDestination({ operations, message, job: currentJob, reference: currentReference, reachability, inspectedAt,
            ...(evidence ? { evidence, browserVisible: true } : {}) })
          : await persistDestinationAdmission({ jobs, operations, message, job: currentJob, reference: currentReference, reachability, inspectedAt,
            ...(evidence ? { evidence, browserVisible: true } : {}) });
        if ('obsolete' in result && result.obsolete) {
          await settleWithoutVerification(queued, message, inspectedAt, 'obsolete');
          continue;
        }
        if ('incident' in result && result.incident) opened.push(result.incident);
        const attemptId = candidateOnly
          ? `historical-backfill:${message.generationId ?? 'unknown'}:${crypto.randomUUID()}`
          : crypto.randomUUID();
        await operations.recordVerificationAttempt({ id: attemptId, jobId: message.jobId, sourceId: message.sourceId,
          candidateUrl: message.candidateUrl, state: browserError ? 'failed' : 'succeeded', classification: result.destination.classification,
          ...(browserError ? { error: browserError instanceof Error ? browserError.message.slice(0, 500) : String(browserError).slice(0, 500) } : {}),
          attemptedAt, completedAt: inspectedAt }, !candidateOnly && result.destination.evidenceHash ? { hash: result.destination.evidenceHash,
          classification: result.destination.classification, value: result.destination, observedAt: inspectedAt } : undefined);
        if (candidateOnly && message.generationId && message.occurrenceKey && !browserError) {
          await operations.recordBackfillEvidence({ generationId: message.generationId, occurrenceKey: message.occurrenceKey,
            evidenceHash: result.destination.evidenceHash ?? createHash('sha256').update(JSON.stringify(result.destination)).digest('hex'),
            classification: result.destination.classification, value: result.destination, observedAt: inspectedAt });
        }
        const retryTransientFailure = Boolean(browserError && reachability !== 'gone');
        if (!candidateOnly && message.occurrenceKey) {
          if (retryTransientFailure) {
            if (message.leaseToken) {
              await operations.deferScheduledVerificationRetry({ occurrenceKey: message.occurrenceKey,
                leaseToken: message.leaseToken, updatedAt: inspectedAt,
                deferredUntil: new Date(Date.parse(inspectedAt) + DESTINATION_RETRY_DELAY_SECONDS * 1_000
                  + DESTINATION_RETRY_LEASE_MARGIN_MS).toISOString() });
            }
          } else {
            await operations.completeScheduledVerification({ occurrenceKey: message.occurrenceKey, leaseToken: message.leaseToken,
              completedAt: inspectedAt, classification: result.destination.classification,
              nextCheckAt: result.destination.nextCheckAt ?? new Date(Date.parse(inspectedAt) + 6 * 86_400_000).toISOString() });
          }
        }
        if (retryTransientFailure) queued.retry({ delaySeconds: DESTINATION_RETRY_DELAY_SECONDS });
        else {
          if (message.idempotencyKey) await operations.recordVerificationCompletion(message.idempotencyKey, inspectedAt);
          queued.ack();
        }
      } catch {
        queued.retry({ delaySeconds: 300 });
      }
    }
  } catch {
    for (const { queued } of pending) queued.retry({ delaySeconds: 300 });
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
  env: Pick<DestinationVerificationEnvironment, 'DB' | 'DESTINATION_VERIFICATION_QUEUE' | 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  now = new Date(),
  options: { syncSchedule?: boolean } = { syncSchedule: true },
): Promise<number> {
  const operations = new D1CatalogAdmissionStore(env.DB);
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
  const scheduledAt = now.toISOString();
  if (options.syncSchedule !== false) await operations.syncVerificationSchedule(scheduledAt);
  for (const candidate of await operations.leaseDueVerifications(scheduledAt)) {
    const idempotencyKey = createHash('sha256').update(`${candidate.occurrenceKey}\0${candidate.nextCheckAt}`).digest('hex');
    await env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage({
      jobId: candidate.jobId, sourceId: candidate.sourceId, externalId: candidate.externalId,
      providerIdentity: candidate.providerIdentity, candidateUrl: candidate.candidateUrl, reason: 'daily-retry',
      occurrenceKey: candidate.occurrenceKey, leaseToken: candidate.leaseToken, idempotencyKey,
    }, scheduledAt));
    await operations.markVerificationEnqueued(candidate.occurrenceKey, candidate.leaseToken, scheduledAt);
    queued += 1;
  }
  return queued;
}
