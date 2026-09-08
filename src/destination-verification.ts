import { sourceRoleAgreement, type ApplicationPageEvidence } from './core/application-url.js';
import { providerPostingReference } from './identity/posting.js';
import type { CanonicalEmployer, DestinationEvidence, DestinationReviewRule, Internship, ProcessedListing, ProviderIdentity } from './types.js';
import type { Reachability } from './core/application-verification.js';
import { evidenceHash } from './catalog-admission.js';

export interface DestinationVerificationRequest {
  jobId: string;
  sourceId: string;
  externalId: string;
  providerIdentity: ProviderIdentity;
  candidateUrl: string;
  reason: 'first-sight' | 'url-change' | 'content-change' | 'daily-retry' | 'weekly-sample' | 'historical-backfill';
  /** Optional additive fields keep already-queued v1 messages valid. */
  metadataExtractionVersion?: number;
  metadataArtifactHash?: string;
  metadataBackfillToken?: string;
}

export interface CatalogAdmissionResolver {
  resolveCanonicalEmployer(identity: ProviderIdentity): Promise<Pick<CanonicalEmployer, 'id' | 'displayName'> | undefined>;
  resolveDestinationRule(identity: ProviderIdentity, candidateUrl: string): Promise<DestinationReviewRule | undefined>;
  configurationVersion?(): Promise<string>;
}

export function matchingBrowserDestination(
  existing: Internship | undefined,
  request: Pick<DestinationVerificationRequest, 'sourceId' | 'externalId' | 'providerIdentity' | 'candidateUrl'>,
  queuedAt?: string,
): DestinationEvidence | undefined {
  const reference = existing?.sourceReferences.find((item) => item.sourceId === request.sourceId && item.externalId === request.externalId);
  const destination = reference?.admission?.destination;
  if (!destination?.browserVisible || destination.candidateUrl !== request.candidateUrl
    || destination.provider !== request.providerIdentity.provider) return undefined;
  if (request.providerIdentity.tenant
    && destination.tenant?.toLowerCase() !== request.providerIdentity.tenant.toLowerCase()) return undefined;
  if (request.providerIdentity.postingId
    && destination.expectedPostingId?.toLowerCase() !== request.providerIdentity.postingId.toLowerCase()) return undefined;
  if (queuedAt) {
    const queuedAtMs = Date.parse(queuedAt);
    const inspectedAtMs = Date.parse(destination.inspectedAt);
    if (!Number.isFinite(queuedAtMs) || !Number.isFinite(inspectedAtMs) || inspectedAtMs < queuedAtMs) return undefined;
  }
  return destination;
}

function standardRouteMatches(identity: ProviderIdentity, url: string): boolean {
  try {
    const reference = providerPostingReference(url);
    if (reference.provider !== 'unknown'
      && reference.provider === identity.provider
      && Boolean(reference.postingId && identity.postingId && reference.postingId === identity.postingId)
      && (!identity.tenant || !reference.tenant || reference.tenant.toLowerCase() === identity.tenant.toLowerCase())) return true;
    if (!identity.tenant || !identity.postingId) return false;
    const candidate = new URL(url);
    const host = candidate.hostname.replace(/^www\./u, '').toLowerCase();
    const parts = candidate.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
    const tenant = identity.tenant.toLowerCase();
    const postingId = identity.postingId.toLowerCase();
    if (identity.provider === 'lever' && host === 'jobs.lever.co') {
      return parts[0] === tenant && parts[1] === postingId && (parts.length === 2 || (parts.length === 3 && parts[2] === 'apply'));
    }
    if (identity.provider === 'greenhouse' && ['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(host)) {
      return parts[0] === tenant && parts[1] === 'jobs' && parts[2] === postingId && parts.length === 3;
    }
    if (identity.provider === 'ashby' && host === 'jobs.ashbyhq.com') {
      return parts[0] === tenant && parts[1] === postingId && (parts.length === 2 || (parts.length === 3 && parts[2] === 'application'));
    }
    return false;
  } catch {
    return false;
  }
}

function looksLikeForm(url: string, evidence?: ApplicationPageEvidence): boolean {
  try {
    return evidence?.applicationFormPresent === true || /\/(?:apply|application)(?:\/|$)/iu.test(new URL(url).pathname);
  } catch {
    return evidence?.applicationFormPresent === true;
  }
}

function routeContainsPostingId(identity: ProviderIdentity, url: string): boolean {
  if (!identity.postingId) return false;
  try {
    const candidate = new URL(url);
    const expected = identity.postingId.toLowerCase();
    return candidate.pathname.split('/').filter(Boolean).some((part) => decodeURIComponent(part).toLowerCase() === expected)
      || [...candidate.searchParams.values()].some((value) => value.toLowerCase() === expected);
  } catch {
    return false;
  }
}

export function classifyDestination(input: {
  listing: ProcessedListing;
  reachability: Reachability;
  evidence?: ApplicationPageEvidence;
  inspectedAt: string;
  browserVisible?: boolean;
  rule?: DestinationReviewRule;
}): DestinationEvidence {
  const identity = input.listing.providerIdentity ?? {
    provider: input.listing.postingIdentity?.provider ?? 'unknown',
    sourceId: input.listing.sourceId,
    sourceUrl: input.listing.sourceUrl,
    postingId: input.listing.postingIdentity?.providerPostingId ?? input.listing.externalId,
    tenant: input.listing.postingIdentity?.tenant,
  };
  const candidateUrl = input.listing.applyUrl;
  const finalUrl = input.evidence?.url;
  const common = {
    candidateUrl,
    ...(finalUrl ? { finalUrl } : {}),
    provider: identity.provider,
    ...(identity.tenant ? { tenant: identity.tenant } : {}),
    ...(identity.postingId ? { expectedPostingId: identity.postingId } : {}),
    inspectedAt: input.inspectedAt,
    ...(input.evidence ? { evidenceHash: evidenceHash({
      url: input.evidence.url,
      title: input.evidence.title,
      description: input.evidence.description,
      contentHash: input.evidence.contentHash,
      inspectionTruncated: input.evidence.inspectionTruncated,
      inspectedBytes: input.evidence.inspectedBytes,
      postingIdPresent: input.evidence.postingIdPresent,
      jobPostingCount: input.evidence.jobPostingCount,
      distinctJobLinkCount: input.evidence.distinctJobLinkCount,
      applicationFormPresent: input.evidence.applicationFormPresent,
      evidenceFrameUrl: input.evidence.evidenceFrameUrl,
      evidenceFrameKind: input.evidence.evidenceFrameKind,
      renderedFrameCount: input.evidence.renderedFrameCount,
      failedFrameCount: input.evidence.failedFrameCount,
      selfReferentialFrame: input.evidence.selfReferentialFrame,
      renderedEvidenceHash: input.evidence.renderedEvidenceHash,
      identicalEvidenceForDifferentPosting: input.evidence.identicalEvidenceForDifferentPosting,
    }) } : {}),
    ...(input.evidence?.postingIdPresent !== undefined ? { postingIdPresent: input.evidence.postingIdPresent } : {}),
    ...(input.evidence?.inspectionTruncated !== undefined ? { inspectionTruncated: input.evidence.inspectionTruncated } : {}),
    ...(input.evidence?.inspectedBytes !== undefined ? { inspectedBytes: input.evidence.inspectedBytes } : {}),
    ...(input.evidence?.jobPostingCount !== undefined ? { jobPostingCount: input.evidence.jobPostingCount } : {}),
    ...(input.evidence?.distinctJobLinkCount !== undefined ? { distinctJobLinkCount: input.evidence.distinctJobLinkCount } : {}),
    ...(input.evidence?.applicationFormPresent !== undefined ? { applicationFormPresent: input.evidence.applicationFormPresent } : {}),
    ...(input.evidence?.evidenceFrameUrl ? { evidenceFrameUrl: input.evidence.evidenceFrameUrl } : {}),
    ...(input.evidence?.evidenceFrameKind ? { evidenceFrameKind: input.evidence.evidenceFrameKind } : {}),
    ...(input.evidence?.renderedFrameCount !== undefined ? { renderedFrameCount: input.evidence.renderedFrameCount } : {}),
    ...(input.evidence?.failedFrameCount !== undefined ? { failedFrameCount: input.evidence.failedFrameCount } : {}),
    ...(input.evidence?.selfReferentialFrame !== undefined ? { selfReferentialFrame: input.evidence.selfReferentialFrame } : {}),
    ...(input.evidence?.renderedEvidenceHash ? { renderedEvidenceHash: input.evidence.renderedEvidenceHash } : {}),
    ...(input.evidence?.identicalEvidenceForDifferentPosting !== undefined
      ? { identicalEvidenceForDifferentPosting: input.evidence.identicalEvidenceForDifferentPosting } : {}),
    ...(input.browserVisible !== undefined ? { browserVisible: input.browserVisible } : {}),
  } satisfies Omit<DestinationEvidence, 'classification'>;

  if (input.reachability === 'gone') return { ...common, classification: 'gone' };
  if (input.rule?.decision === 'aggregate-board') return { ...common, classification: 'aggregate-board' };
  const singleStructuredPosting = input.evidence?.inspectionTruncated !== true && input.evidence?.jobPostingCount === 1;
  const exactPostingEvidence = input.evidence?.postingIdPresent === true
    || singleStructuredPosting || input.evidence?.applicationFormPresent === true;
  // Navigation and related-role links do not turn a matching, structured
  // single posting into a board. A URL/ID echoed in a shell is not enough to
  // override the high-link-count guard; contradictory evidence still wins.
  const matchingSinglePosting = singleStructuredPosting && input.evidence
    && sourceRoleAgreement(input.listing.title, input.evidence) !== 'weak';
  if (input.evidence?.identicalEvidenceForDifferentPosting || input.evidence?.redirectedToGenericDestination
    || (input.evidence?.jobPostingCount ?? 0) > 1) {
    return { ...common, classification: 'aggregate-board' };
  }
  if (((input.evidence?.distinctJobLinkCount ?? 0) >= 8 && !matchingSinglePosting)
    || ((input.evidence?.distinctJobLinkCount ?? 0) > 1 && !exactPostingEvidence)) {
    // A matching structured prefix cannot prove either a single posting or a
    // board. Keep it hidden but recoverable by the browser-verification queue.
    if (input.evidence?.inspectionTruncated === true && input.evidence.jobPostingCount === 1
      && sourceRoleAgreement(input.listing.title, input.evidence) !== 'weak') {
      return { ...common, classification: 'unresolved' };
    }
    return { ...common, classification: 'aggregate-board' };
  }
  if (input.reachability === 'blocked' && input.rule?.decision === 'blocked-accepted' && routeContainsPostingId(identity, candidateUrl)) {
    return { ...common, classification: looksLikeForm(finalUrl ?? candidateUrl, input.evidence) ? 'application-form' : 'posting-detail' };
  }
  const standard = (input.rule?.decision === 'standard-provider-route' && routeContainsPostingId(identity, candidateUrl))
    || (input.rule?.decision !== 'browser-required' && standardRouteMatches(identity, candidateUrl));
  if (standard) {
    return { ...common, classification: looksLikeForm(finalUrl ?? candidateUrl, input.evidence) ? 'application-form' : 'posting-detail' };
  }
  if (input.rule?.decision === 'browser-required' && input.browserVisible !== true) {
    return { ...common, classification: input.reachability === 'blocked' ? 'blocked-uninspectable' : 'unresolved' };
  }
  if (input.reachability === 'blocked') return { ...common, classification: 'blocked-uninspectable' };
  if (input.reachability !== 'live') return { ...common, classification: 'unresolved' };
  const matchingRole = input.evidence ? sourceRoleAgreement(input.listing.title, input.evidence) !== 'weak' : false;
  const renderedPostingArtifact = matchingRole && Boolean(input.evidence && (input.evidence.postingIdPresent
    || (input.evidence.inspectionTruncated !== true && input.evidence.jobPostingCount === 1) || input.evidence.applicationFormPresent
    || (input.evidence.contentExcerpt?.length ?? 0) >= 300));
  if (input.evidence?.selfReferentialFrame && !renderedPostingArtifact) return { ...common, classification: 'unresolved' };
  const specificEvidence = input.browserVisible === true
    ? renderedPostingArtifact
    : Boolean(input.evidence?.postingIdPresent || singleStructuredPosting || matchingRole || input.evidence?.applicationFormPresent);
  if (specificEvidence) {
    return { ...common, classification: looksLikeForm(finalUrl ?? candidateUrl, input.evidence) ? 'application-form' : 'posting-detail' };
  }
  return { ...common, classification: 'unresolved' };
}

export function requiresBrowserVerification(destination: DestinationEvidence): boolean {
  return destination.classification === 'unresolved' || destination.classification === 'blocked-uninspectable';
}
