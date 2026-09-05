import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import { createHash } from 'node:crypto';
import { evaluateCatalogAdmission, deriveCanonicalAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination, matchingBrowserDestination } from '../src/destination-verification.js';
import type { DestinationVerificationRequest } from '../src/destination-verification.js';
import type { ApplicationPageEvidence } from '../src/core/application-url.js';
import { reachabilityFromFailure, type Reachability } from '../src/core/application-verification.js';
import { combineRenderedFrameEvidence, type RenderedFrameSnapshot } from '../src/rendered-destination-evidence.js';
import { newJobNotificationEvent, shouldPromoteDelayedNotification } from '../src/ingestion/catalog-reconciler.js';
import { activeTrustedCommunityPolicy, advanceTrustedCommunityQualification } from '../src/sources/trust-policy.js';
import type { CatalogAdmissionReason, Internship, ProcessedListing, ProviderIdentity, SourceOccurrence } from '../src/types.js';
import { D1CatalogAdmissionStore, ROLE_METADATA_REVALIDATION_MS } from './catalog-admission-store.js';
import { D1InternshipStore } from './d1-store.js';
import { extractVerifiedPageMetadataEvidence, projectRoleMetadata, replaceVerifiedPageMetadataEvidence, roleMetadataEvidenceHasFields, ROLE_METADATA_EXTRACTION_VERSION, VERIFIED_PAGE_METADATA_SOURCES } from '../src/role-metadata.js';
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
  metadataExtractionVersion?: number;
  metadataArtifactHash?: string;
  metadataBackfillToken?: string;
}

export interface DestinationVerificationEnvironment {
  DB: D1Database;
  DESTINATION_BROWSER: BrowserWorker;
  DESTINATION_VERIFICATION_QUEUE: Queue;
  RESEND_API_KEY?: string;
  ADMISSION_SUPPORT_RECIPIENT?: string;
  TRUSTED_COMMUNITY_CATALOG_ENABLED?: string;
  IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED?: string;
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

function metadataExtractionCurrent(reference: SourceOccurrence, message: DestinationVerificationMessage): boolean {
  if (!message.metadataExtractionVersion) return true;
  return reference.metadataExtraction?.version === message.metadataExtractionVersion
    && (!message.metadataArtifactHash || reference.metadataExtraction.artifactHash === message.metadataArtifactHash);
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
  trustedCommunityCatalogEnabled?: boolean;
  identityUnconfirmedPublicationEnabled?: boolean;
}): Promise<{
  destination: ReturnType<typeof classifyDestination>;
  incident?: { sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' };
}> {
  const { jobs, operations, message, job, reference, reachability, inspectedAt, evidence, browserVisible } = input;
  const occurrence = (await jobs.getSourceOccurrences(message.sourceId)).find((item) => item.externalId === message.externalId);
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
  const trustedCommunityPolicy = activeTrustedCommunityPolicy(message.sourceId, input.trustedCommunityCatalogEnabled ?? false);
  const trustedCommunityAlertQualification = trustedCommunityPolicy
    ? advanceTrustedCommunityQualification({
      previous: occurrence?.occurrence.trustedCommunityAlertQualification
        ?? reference.trustedCommunityAlertQualification,
      destination,
      postingIdentityDecision: reference.postingIdentityDecision,
      alertMode: trustedCommunityPolicy.alertMode,
    })
    : undefined;
  const admission = evaluateCatalogAdmission({
    listing, destination,
    postingAttributed: reference.provenance !== 'reviewed-community'
      || reference.admission?.postingAttribution === 'attributed'
      || (browserVisible === true && ['posting-detail', 'application-form'].includes(destination.classification)),
    evaluatedAt: inspectedAt, previous: reference.admission ?? job.admission,
    ...(trustedCommunityPolicy && trustedCommunityAlertQualification
      ? { trustedCommunity: { policy: trustedCommunityPolicy, qualification: trustedCommunityAlertQualification } }
      : {}),
  });
  const extracted = evidence && ['posting-detail', 'application-form'].includes(destination.classification)
    ? extractVerifiedPageMetadataEvidence({
      expectedTitle: reference.title,
      expectedPostingId: message.providerIdentity.postingId,
      page: { title: evidence.title ?? reference.title,
        text: evidence.contentSource === 'json-ld' ? undefined : evidence.contentExcerpt },
      jsonLdArtifacts: evidence.metadataArtifacts,
      sourceId: message.sourceId,
      sourceUrl: evidence.url,
      observedAt: inspectedAt,
      exactPosting: true,
    }) : [];
  const metadataEvidence = evidence
    ? replaceVerifiedPageMetadataEvidence(reference.metadataEvidence, extracted, message.sourceId)
    : reference.metadataEvidence;
  const enrichedReference = { ...reference, admission,
    ...(trustedCommunityAlertQualification ? { trustedCommunityAlertQualification } : {}),
    ...(evidence ? { metadataEvidence } : {}),
    ...(evidence ? { metadataExtraction: {
      version: message.metadataExtractionVersion ?? 1,
      artifactHash: evidence.contentHash ?? evidence.renderedEvidenceHash ?? createHash('sha256').update(JSON.stringify({ url: evidence.url, title: evidence.title, description: evidence.description })).digest('hex'),
      observedAt: inspectedAt,
      outcome: extracted.some(roleMetadataEvidenceHasFields) ? 'extracted' as const : 'no-explicit-metadata' as const,
    } } : {}),
  };
  const sourceReferences = job.sourceReferences.map((item) => item === reference ? enrichedReference : item);
  const projected = projectRoleMetadata({ ...job, sourceReferences, admission: deriveCanonicalAdmission(sourceReferences, inspectedAt) });
  if (evidence && enrichedReference.metadataExtraction) await operations.recordRoleMetadataExtraction({
    jobId: job.jobId, sourceId: message.sourceId, sourceUrl: evidence.url,
    artifactHash: enrichedReference.metadataExtraction.artifactHash,
    extractionVersion: enrichedReference.metadataExtraction.version,
    outcome: enrichedReference.metadataExtraction.outcome,
    observedAt: inspectedAt,
    ...(message.metadataBackfillToken ? { backfillToken: message.metadataBackfillToken } : {}),
  });
  if (evidence) await operations.recordRoleMetadataEvidence(job.jobId, extracted, projected.conflicts, inspectedAt, {
    sourceId: message.sourceId,
    sourceClasses: VERIFIED_PAGE_METADATA_SOURCES,
  });
  // Historical collection is deliberately staging-only. The guarded repair
  // endpoint performs the public job write after exact token/count checks.
  if (message.metadataBackfillToken) return { destination };
  const canonicalAdmission = deriveCanonicalAdmission(sourceReferences, inspectedAt);
  const becomingCatalogVisible = !job.catalogVisibleAt && job.admission?.catalogEligible === false && canonicalAdmission?.catalogEligible === true;
  // Only the trusted policy supplies durable baseline/qualification evidence.
  // Preserve standard-source behavior when this rollout is inactive.
  const delayedPromotion = Boolean(trustedCommunityPolicy && trustedCommunityAlertQualification
    && job.open && job.technical !== false
    && (job.postingIdentityStatus !== 'unconfirmed' || input.identityUnconfirmedPublicationEnabled === true)
    && shouldPromoteDelayedNotification({
      previousOccurrenceAlertEligible: reference.admission?.alertEligible,
      occurrenceAlertEligible: admission.alertEligible,
      canonicalAlertEligible: canonicalAdmission?.alertEligible,
      baselineSuppressed: trustedCommunityAlertQualification?.baselineSuppressed,
    }));
  const nextJob: Internship = {
    ...projected.job,
    sourceReferences,
    ...(canonicalAdmission ? { admission: canonicalAdmission } : {}),
    ...(becomingCatalogVisible ? { catalogVisibleAt: inspectedAt,
      catalogRecency: trustedCommunityAlertQualification?.baselineSuppressed ? 'baseline' : 'normal' } : {}),
    ...(delayedPromotion ? { notification: { ...job.notification, smsPending: true, digestPending: true } } : {}),
  };
  const nextOccurrence = occurrence ? {
    ...occurrence,
    occurrence: { ...occurrence.occurrence, ...enrichedReference },
    changedAt: inspectedAt,
  } : undefined;
  if (nextOccurrence && reference.postingIdentityDecision && reference.postingIdentityDecision.status !== 'quarantined') {
    await jobs.commitPostingObservation({
      decision: reference.postingIdentityDecision,
      ...(job.postingIdentity ? { identity: job.postingIdentity } : {}),
      job: nextJob,
      occurrence: nextOccurrence,
      ...(delayedPromotion ? { notificationEvent: newJobNotificationEvent(message.sourceId, message.externalId, nextJob, inspectedAt) } : {}),
    });
  } else {
    await jobs.putAdmissionState(nextJob, nextOccurrence);
  }

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
  const pending: Array<{ queued: MessageBatch<unknown>['messages'][number]; message: DestinationVerificationMessage }> = [];
  const pendingAttemptKeys = new Set<string>();
  const recentAttemptCutoff = new Date(now().getTime() - 24 * 60 * 60_000).toISOString();
  for (const queued of batch.messages) {
    try {
      const message = parseMessage(queued.body);
      const job = await jobs.getJob(message.jobId);
      if (!job) { queued.ack(); continue; }
      const reference = job.sourceReferences.find((item) => item.sourceId === message.sourceId && item.externalId === message.externalId);
      const attemptKey = `${message.jobId}\0${message.sourceId}\0${message.candidateUrl}`;
      if (!reference || (matchingBrowserDestination(job, message, message.queuedAt) && metadataExtractionCurrent(reference, message))
        || pendingAttemptKeys.has(attemptKey)
        || (metadataExtractionCurrent(reference, message)
          && await operations.hasVerificationAttemptSince(message.jobId, message.sourceId, message.candidateUrl, recentAttemptCutoff))) {
        queued.ack(); continue;
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
        const job = await jobs.getJob(message.jobId);
        if (!job) { queued.ack(); continue; }
        const reference = job.sourceReferences.find((item) => item.sourceId === message.sourceId && item.externalId === message.externalId);
        if (!reference || (matchingBrowserDestination(job, message, message.queuedAt) && metadataExtractionCurrent(reference, message))) { queued.ack(); continue; }
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
                const snapshot = await frame.evaluate(() => {
                  const visible = (element: Element) => element.getClientRects().length > 0;
                  const structuredJobText: string[] = [];
                  let jobPostingCount = 0;
                  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
                    const text = node.textContent ?? '';
                    const matches = text.match(/["']@type["']\s*:\s*["']JobPosting["']/gi) ?? [];
                    jobPostingCount += matches.length;
                    if (matches.length) structuredJobText.push(text.slice(0, 20_000));
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
                  return {
                    url: location.href, title: document.title || undefined, description,
                    visibleText: main || undefined, structuredJobText: structuredJobText.join(' ').slice(0, 40_000) || undefined,
                    structuredJobDocuments: structuredJobText,
                    jobPostingCount, distinctJobLinkCount: distinctJobLinks.size,
                    applicationFormPresent: actionableApply || [...document.querySelectorAll<Element>(
                      'form[action*="apply" i],form[id*="apply" i],input[type="file"],input[name="resume" i],input[name="cv" i]',
                    )].some(visible),
                  };
                });
                renderedFrames.push({ ...snapshot, ...(frame.parentFrame() ? { parentUrl: frame.parentFrame()!.url() } : {}) });
              } catch {
                failedFrameCount += 1;
              }
            }
            evidence = combineRenderedFrameEvidence({ role: reference.title, expectedPostingId: message.providerIdentity.postingId,
              frames: renderedFrames, failedFrameCount });
            if (evidence?.renderedEvidenceHash && message.providerIdentity.postingId) {
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
        for (const collisionJobId of collisionJobIds) {
          const collisionJob = await jobs.getJob(collisionJobId);
          const collisionReference = collisionJob?.sourceReferences.find((item) => item.externalId
            && item.admission?.destination.renderedEvidenceHash === evidence?.renderedEvidenceHash);
          const prior = collisionReference?.admission?.destination;
          if (!collisionJob || !collisionReference?.externalId || !prior?.expectedPostingId) continue;
          const collisionMessage: DestinationVerificationMessage = {
            version: 1, jobId: collisionJob.jobId, sourceId: collisionReference.sourceId,
            externalId: collisionReference.externalId, candidateUrl: prior.candidateUrl, reason: 'weekly-sample', queuedAt: attemptedAt,
            metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
            providerIdentity: { provider: prior.provider, sourceId: collisionReference.sourceId, sourceUrl: collisionReference.sourceUrl,
              ...(prior.tenant ? { tenant: prior.tenant } : {}), postingId: prior.expectedPostingId },
          };
          const collisionResult = await persistDestinationAdmission({ jobs, operations, message: collisionMessage,
            job: collisionJob, reference: collisionReference, reachability: 'live', inspectedAt, browserVisible: true,
            trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
            identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
            evidence: { url: prior.finalUrl ?? prior.candidateUrl, expectedPostingId: prior.expectedPostingId,
              renderedEvidenceHash: prior.renderedEvidenceHash, identicalEvidenceForDifferentPosting: true,
              confidence: { score: 0, level: 'low', recommendation: 'review', signals: ['identical rendered evidence for different posting IDs'] } } });
          if (collisionResult.incident) opened.push(collisionResult.incident);
        }
        const result = await persistDestinationAdmission({ jobs, operations, message, job, reference, reachability, inspectedAt,
          trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
          identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
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
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
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
        metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      }, now.toISOString()));
      queued += 1;
    }
    await operations.markReviewRuleSampled(rule.id, new Date(now.getTime() + 7 * 86_400_000).toISOString());
  }
  for (const candidate of await operations.legacyVerificationCandidates(100)) {
    await env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage({
      jobId: candidate.jobId, sourceId: candidate.sourceId, externalId: candidate.externalId,
      providerIdentity: candidate.providerIdentity, candidateUrl: candidate.candidateUrl, reason: 'historical-backfill',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
    }, now.toISOString()));
    queued += 1;
  }
  const metadataObservedBefore = new Date(now.getTime() - ROLE_METADATA_REVALIDATION_MS).toISOString();
  for (const candidate of await operations.metadataVerificationCandidates(100, {
    observedBefore: metadataObservedBefore,
    includeUnobserved: false,
    requireProjectedEvidence: true,
  })) {
    await env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage({
      jobId: candidate.jobId, sourceId: candidate.sourceId, externalId: candidate.externalId,
      providerIdentity: candidate.providerIdentity, candidateUrl: candidate.candidateUrl, reason: 'content-change',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      ...(candidate.metadataArtifactHash ? { metadataArtifactHash: candidate.metadataArtifactHash } : {}),
    }, now.toISOString()));
    queued += 1;
  }
  return queued;
}
