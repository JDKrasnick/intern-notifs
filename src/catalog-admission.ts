import { createHash } from 'node:crypto';
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
const TRAILING_FRAGMENT = /(?:\b[A-Za-z]{1,2}|[,/(&[{-])\s*$/u;

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
  let titleState: MetadataCompleteness['title'] = !title
    ? 'missing'
    : ELLIPSIS.test(title)
      ? 'truncated'
      : delimiterState(title) === 'malformed' || TRAILING_FRAGMENT.test(title)
        ? 'malformed'
        : input.titleRepaired ? 'approximate-repair' : 'complete';
  // Words of two characters are legitimate titles (AI, ML), so only treat a
  // trailing fragment as malformed when it follows an otherwise long value.
  if (title.length < 12 && titleState === 'malformed') titleState = 'complete';
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
    && ['posting-detail', 'application-form'].includes(previous.destination.classification);
  const newlyInconclusive = destination.classification === 'unresolved' || destination.classification === 'blocked-uninspectable';
  const graceDeadline = previouslyGood && newlyInconclusive
    ? previous.graceDeadline ?? new Date(Date.parse(evaluatedAt) + 7 * 86_400_000).toISOString()
    : undefined;
  const inGrace = Boolean(graceDeadline && Date.parse(evaluatedAt) < Date.parse(graceDeadline));
  if (inGrace) {
    const index = reasons.findIndex((reason) => reason === 'destination-unresolved' || reason === 'destination-blocked-uninspectable');
    if (index >= 0) reasons.splice(index, 1, 'destination-grace');
  }
  const blocking = reasons.filter((reason) => reason !== 'destination-grace');
  const catalogEligible = blocking.length === 0 && (destination.classification === 'posting-detail'
    || destination.classification === 'application-form'
    || inGrace);
  return {
    ...(employer && !genericEmployer ? { canonicalEmployer: employer } : {}),
    employerResolution: employer && !genericEmployer ? 'resolved' : 'unresolved',
    postingAttribution: postingAttributed ? 'attributed' : 'unattributed',
    destination: inGrace && previous ? {
      ...destination,
      finalUrl: previous.destination.finalUrl ?? previous.destination.candidateUrl,
      lastKnownGoodAt: previous.destination.inspectedAt,
    } : destination,
    metadata,
    catalogEligible,
    alertEligible: catalogEligible && !inGrace,
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
  const admissible = decisions.filter((decision) => decision.catalogEligible)
    .sort((a, b) => Number(b.alertEligible) - Number(a.alertEligible) || b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
  if (admissible) return { ...admissible, evaluatedAt };
  const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
  return { ...latest, catalogEligible: false, alertEligible: false, evaluatedAt };
}

export function catalogEligible(job: { admission?: CatalogAdmission }): boolean {
  return job.admission?.catalogEligible ?? true;
}

export function alertEligible(job: { admission?: CatalogAdmission }): boolean {
  return job.admission?.alertEligible ?? true;
}

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
