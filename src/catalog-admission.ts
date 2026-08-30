import { createHash } from 'node:crypto';
import { sourceRoleAgreement } from './core/application-url.js';
import type {
  CatalogAdmission,
  CatalogAdmissionReason,
  DestinationEvidence,
  MetadataCompleteness,
  ProcessedListing,
  SourceOccurrence,
} from './types.js';

const GENERIC_EMPLOYER = /\b(?:talent community|job board|open roles?|careers?|external|private|job wrapping|university jobs?|early career)\b/iu;
const ELLIPSIS = /(?:\.{2,}|…)/u;
const TRAILING_FRAGMENT = /[,/(&[{-]\s*$/u;

export function isGenericEmployerLabel(value: string): boolean {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return !normalized || GENERIC_EMPLOYER.test(normalized);
}

function delimiterState(value: string): 'complete' | 'malformed' {
  const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
  return pairs.some(([open, close]) => value.split(open).length !== value.split(close).length)
    ? 'malformed'
    : 'complete';
}

export function metadataCompleteness(input: {
  title: string;
  locations: readonly string[];
  titleRepaired?: boolean;
}): MetadataCompleteness {
  const title = input.title.replace(/\s+/gu, ' ').trim();
  const sourceLocation = input.locations.join(' · ').replace(/\s+/gu, ' ').trim();
  const titleState: MetadataCompleteness['title'] = !title
    ? 'missing'
    : ELLIPSIS.test(title)
      ? 'truncated'
      : delimiterState(title) === 'malformed' || TRAILING_FRAGMENT.test(title)
        ? 'malformed'
        : input.titleRepaired ? 'approximate-repair' : 'complete';
  const locationState: MetadataCompleteness['location'] = !sourceLocation
    ? 'not-specified'
    : ELLIPSIS.test(sourceLocation)
      ? 'truncated'
      : delimiterState(sourceLocation) === 'malformed' || /\b[A-Za-z]{1,2}\.{2,}\s*$/u.test(sourceLocation)
        ? 'malformed'
        : 'complete';
  return {
    complete: titleState === 'complete' && (locationState === 'complete' || locationState === 'not-specified'),
    title: titleState,
    location: locationState,
  };
}

function metadataReasons(metadata: MetadataCompleteness): CatalogAdmissionReason[] {
  const reasons: CatalogAdmissionReason[] = [];
  if (metadata.title === 'missing') reasons.push('metadata-title-missing');
  if (metadata.title === 'truncated') reasons.push('metadata-title-truncated');
  if (metadata.title === 'malformed') reasons.push('metadata-title-malformed');
  if (metadata.title === 'approximate-repair') reasons.push('metadata-title-approximate-repair');
  if (metadata.location === 'truncated') reasons.push('metadata-location-truncated');
  if (metadata.location === 'malformed') reasons.push('metadata-location-malformed');
  return reasons;
}

function destinationReason(destination: DestinationEvidence): CatalogAdmissionReason | undefined {
  if (destination.classification === 'aggregate-board') return 'destination-aggregate-board';
  if (destination.classification === 'blocked-uninspectable') return 'destination-blocked-uninspectable';
  if (destination.classification === 'gone') return 'destination-gone';
  if (destination.classification === 'unresolved') return 'destination-unresolved';
  return undefined;
}

export function evaluateCatalogAdmission(input: {
  listing: ProcessedListing;
  destination: DestinationEvidence;
  postingAttributed: boolean;
  evaluatedAt: string;
  previous?: CatalogAdmission;
}): CatalogAdmission {
  const { listing, destination, postingAttributed, evaluatedAt, previous } = input;
  const employer = listing.employerEvidence?.canonicalEmployer;
  const genericEmployer = isGenericEmployerLabel(employer?.displayName ?? listing.company);
  const metadata = listing.metadataCompleteness ?? metadataCompleteness({
    title: listing.title,
    locations: listing.locations ?? [listing.location],
    titleRepaired: listing.titleRepaired,
  });
  const reasons = metadataReasons(metadata);
  if (!employer) reasons.push('employer-unresolved');
  else if (genericEmployer) reasons.push('employer-generic-label');
  if (!postingAttributed) reasons.push('posting-unattributed');
  const destinationFailure = destinationReason(destination);
  if (destinationFailure) reasons.push(destinationFailure);

  const previouslyGood = previous?.catalogEligible
    && (['posting-detail', 'application-form'].includes(previous.destination.classification)
      || Boolean(previous.destination.lastKnownGoodAt));
  const newlyInconclusive = destination.classification === 'unresolved' || destination.classification === 'blocked-uninspectable';
  const previousFreshUntil = previous?.destination.freshUntil
    ?? (previous?.graceDeadline && previous.destination.lastKnownGoodAt
      ? new Date(Date.parse(previous.graceDeadline) - 7 * 86_400_000).toISOString()
      : previouslyGood ? new Date(Date.parse(previous.destination.inspectedAt) + 7 * 86_400_000).toISOString() : undefined);
  const currentEvidenceStale = ['posting-detail', 'application-form'].includes(destination.classification)
    && Boolean(destination.freshUntil && Date.parse(evaluatedAt) >= Date.parse(destination.freshUntil));
  if (currentEvidenceStale) reasons.push('destination-stale');
  const graceStart = previousFreshUntil && newlyInconclusive ? previousFreshUntil
    : currentEvidenceStale ? destination.freshUntil : undefined;
  const graceDeadline = graceStart
    ? previous?.graceDeadline ?? new Date(Date.parse(graceStart) + 7 * 86_400_000).toISOString()
    : undefined;
  const inGrace = Boolean(graceStart && graceDeadline
    && Date.parse(evaluatedAt) >= Date.parse(graceStart)
    && Date.parse(evaluatedAt) < Date.parse(graceDeadline));
  const beforePriorExpiry = Boolean(previouslyGood && newlyInconclusive && previousFreshUntil
    && Date.parse(evaluatedAt) < Date.parse(previousFreshUntil));
  if (beforePriorExpiry) {
    const transient = reasons.findIndex((reason) => reason === 'destination-unresolved' || reason === 'destination-blocked-uninspectable');
    if (transient >= 0) reasons.splice(transient, 1);
  }
  if (inGrace) {
    const index = reasons.findIndex((reason) => reason === 'destination-unresolved'
      || reason === 'destination-blocked-uninspectable' || reason === 'destination-stale');
    if (index >= 0) reasons.splice(index, 1, 'destination-grace');
  }
  const blocking = reasons.filter((reason) => reason !== 'destination-grace');
  const catalogEligible = blocking.length === 0 && (destination.classification === 'posting-detail'
    || destination.classification === 'application-form'
    || inGrace || beforePriorExpiry);
  const retainedDestination = (inGrace || beforePriorExpiry) && previous ? {
    ...destination,
    finalUrl: previous.destination.finalUrl ?? previous.destination.candidateUrl,
    lastKnownGoodAt: previous.destination.inspectedAt,
    ...(previousFreshUntil ? { freshUntil: previousFreshUntil } : {}),
    ...(previous.destination.validThrough ? { validThrough: previous.destination.validThrough } : {}),
    nextCheckAt: beforePriorExpiry && previousFreshUntil ? previousFreshUntil
      : new Date(Math.min(Date.parse(evaluatedAt) + 86_400_000, Date.parse(graceDeadline!))).toISOString(),
  } : destination;
  return {
    ...(employer && !genericEmployer ? { canonicalEmployer: employer } : {}),
    employerResolution: employer && !genericEmployer ? 'resolved' : 'unresolved',
    postingAttribution: postingAttributed ? 'attributed' : 'unattributed',
    destination: retainedDestination,
    metadata,
    catalogEligible,
    alertEligible: catalogEligible && !inGrace && !currentEvidenceStale,
    reasonCodes: [...new Set(reasons)].sort(),
    evaluatedAt,
    evidenceObservedAt: destination.inspectedAt,
    ...(graceDeadline ? { graceDeadline } : {}),
  };
}

export function deriveCanonicalAdmission(references: readonly SourceOccurrence[], evaluatedAt: string): CatalogAdmission | undefined {
  const openReferences = references.filter((reference) => reference.state === 'open');
  const relevantReferences = openReferences.length ? openReferences : references;
  const decisions = relevantReferences.map((reference) => reference.admission).filter((value): value is CatalogAdmission => Boolean(value));
  if (!decisions.length) return undefined;
  const officialEmployerIds = new Set(relevantReferences
    .filter((reference) => reference.provenance !== 'reviewed-community')
    .map((reference) => reference.admission?.canonicalEmployer?.id)
    .filter((value): value is string => Boolean(value)));
  if (officialEmployerIds.size > 1) {
    const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
    return {
      ...latest,
      canonicalEmployer: undefined,
      employerResolution: 'conflict',
      catalogEligible: false,
      alertEligible: false,
      reasonCodes: [...new Set([...latest.reasonCodes, 'employer-conflict' as const])].sort(),
      evaluatedAt,
    };
  }
  const identities = new Map<string, SourceOccurrence[]>();
  for (const reference of relevantReferences) {
    const destination = reference.admission?.destination;
    if (!destination?.expectedPostingId) continue;
    const key = `${destination.provider}\0${destination.tenant ?? ''}\0${destination.expectedPostingId}`;
    identities.set(key, [...(identities.get(key) ?? []), reference]);
  }
  const metadataConflict = [...identities.values()].some((group) => {
    const official = group.filter((reference) => reference.provenance !== 'reviewed-community' && reference.admission?.catalogEligible);
    const authoritative = official.length ? official : group;
    return authoritative.some((left, index) => authoritative.slice(index + 1).some((right) => {
    if (left.title.trim().toLowerCase() === right.title.trim().toLowerCase()) return false;
    const generic = (value: string) => /^(?:intern(?:ship)?|co-?op)$/iu.test(value.trim());
    if (generic(left.title) !== generic(right.title)) return true;
    return sourceRoleAgreement(left.title, { url: right.applyUrl, title: right.title,
      confidence: { score: 0, level: 'low', recommendation: 'review', signals: [] } }) === 'weak'
      && sourceRoleAgreement(right.title, { url: left.applyUrl, title: left.title,
        confidence: { score: 0, level: 'low', recommendation: 'review', signals: [] } }) === 'weak';
    }));
  });
  if (metadataConflict) {
    const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
    return { ...latest, catalogEligible: false, alertEligible: false,
      reasonCodes: [...new Set([...latest.reasonCodes, 'metadata-conflict' as const])].sort(), evaluatedAt };
  }
  const admissible = decisions.filter((decision) => decision.catalogEligible)
    .sort((a, b) => Number(b.alertEligible) - Number(a.alertEligible) || b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
  if (admissible) return { ...admissible, evaluatedAt };
  const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
  return { ...latest, catalogEligible: false, alertEligible: false, evaluatedAt };
}

function freshnessDeadlines(admission: CatalogAdmission): { freshUntil?: number; graceDeadline?: number } {
  const freshUntil = admission.destination.freshUntil ? Date.parse(admission.destination.freshUntil) : Number.NaN;
  if (!Number.isFinite(freshUntil)) return {};
  const storedGrace = admission.graceDeadline ? Date.parse(admission.graceDeadline) : Number.NaN;
  return { freshUntil, graceDeadline: Number.isFinite(storedGrace) ? storedGrace : freshUntil + 7 * 86_400_000 };
}

/** Stored decisions are bounded by evidence time even if the verifier or queue is unavailable. */
export function catalogEligible(job: { admission?: CatalogAdmission }, at = new Date()): boolean {
  const admission = job.admission;
  if (!admission) return true;
  if (!admission.catalogEligible) return false;
  const validThrough = admission.destination.validThrough ? Date.parse(admission.destination.validThrough) : Number.NaN;
  if (Number.isFinite(validThrough) && at.getTime() >= validThrough) return false;
  const { graceDeadline } = freshnessDeadlines(admission);
  return graceDeadline === undefined || at.getTime() < graceDeadline;
}

/** Alerts fail closed at freshUntil; the following seven days are catalog-only grace. */
export function alertEligible(job: { admission?: CatalogAdmission }, at = new Date()): boolean {
  const admission = job.admission;
  if (!admission) return true;
  if (!admission.alertEligible) return false;
  const { freshUntil } = freshnessDeadlines(admission);
  return freshUntil === undefined || at.getTime() < freshUntil;
}

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
