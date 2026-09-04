import type {
  CatalogAdmissionReason,
  ProcessedListing,
  SourceOccurrenceState,
  TrustedCommunityAlertMode,
  TrustedCommunitySourceMetrics,
} from '../types.js';

export interface TrustedCommunityBaseline {
  rawRows: number;
  eligibleRows: number;
  destinationFailures: number;
  browserInspectionCandidates: number;
  catalogAdmissions: number;
  alertQualifications: number;
}

export interface TrustedCommunityThresholds {
  minimumRawRows: number;
  minimumEligibleRows: number;
  minimumInspectedCandidates: number;
  minimumInspectionCoverage: number;
  maximumDestinationFailureRate: number;
  maximumBrowserInspectionShare: number;
  minimumCatalogYield: number;
  minimumAlertYield: number;
}

export const SIMPLIFY_TRUSTED_COMMUNITY_BASELINE: TrustedCommunityBaseline = {
  rawRows: 2074,
  eligibleRows: 1738,
  destinationFailures: 0,
  browserInspectionCandidates: 439,
  catalogAdmissions: 1738,
  alertQualifications: 1299,
};

export function trustedCommunityThresholds(baseline: TrustedCommunityBaseline): TrustedCommunityThresholds {
  const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
  return {
    minimumRawRows: Math.ceil(baseline.rawRows * 0.7),
    minimumEligibleRows: Math.ceil(baseline.eligibleRows * 0.7),
    minimumInspectedCandidates: 100,
    minimumInspectionCoverage: 0.9,
    maximumDestinationFailureRate: Math.min(0.2, ratio(baseline.destinationFailures, baseline.eligibleRows) + 0.05),
    maximumBrowserInspectionShare: Math.min(0.5, ratio(baseline.browserInspectionCandidates, baseline.eligibleRows) + 0.1),
    minimumCatalogYield: Math.max(0, ratio(baseline.catalogAdmissions, baseline.rawRows) - 0.1),
    minimumAlertYield: Math.max(0, ratio(baseline.alertQualifications, baseline.eligibleRows) - 0.1),
  };
}

export const SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS = trustedCommunityThresholds(SIMPLIFY_TRUSTED_COMMUNITY_BASELINE);

const DESTINATION_FAILURES = new Set<CatalogAdmissionReason>([
  'destination-aggregate-board',
  'destination-blocked-uninspectable',
  'destination-gone',
  'destination-unresolved',
]);

const TRUSTED_COMMUNITY_DIAGNOSTICS = new Set<CatalogAdmissionReason>([
  'employer-unresolved',
  'posting-unattributed',
]);

function catalogQualified(occurrence: ProcessedListing | SourceOccurrenceState['occurrence']): boolean {
  const admission = occurrence.admission;
  if (!admission) return false;
  const postingSpecific = admission.destination.classification === 'posting-detail'
    || admission.destination.classification === 'application-form';
  return postingSpecific && admission.reasonCodes.every((reason) => TRUSTED_COMMUNITY_DIAGNOSTICS.has(reason));
}

export function trustedCommunityMetrics(input: {
  rawRows: number;
  eligibleRows: number;
  listings: readonly ProcessedListing[];
  priorOccurrences: readonly SourceOccurrenceState[];
  eligibleExternalIds: ReadonlySet<string>;
  admissionConfigurationVersion?: string;
  rejectedAggregatorRows: number;
  survivingAggregatorRows: number;
  duplicateOccurrenceIds: number;
}): TrustedCommunitySourceMetrics {
  const prior = new Map(input.priorOccurrences.map((item) => [item.externalId, item.occurrence]));
  const current = new Map(input.listings.map((item) => [item.externalId!, item]));
  const inspected = [...input.eligibleExternalIds].flatMap((externalId) => {
    const occurrence = current.get(externalId) ?? prior.get(externalId);
    if (!occurrence || (input.admissionConfigurationVersion
      && occurrence.admissionConfigurationVersion !== input.admissionConfigurationVersion)) return [];
    return occurrence.admission ? [occurrence] : [];
  });
  const failuresByReason: TrustedCommunitySourceMetrics['destinationFailuresByReason'] = {};
  for (const occurrence of inspected) {
    for (const reason of occurrence.admission?.reasonCodes ?? []) {
      if (DESTINATION_FAILURES.has(reason)) failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
    }
  }
  const destinationFailures = Object.values(failuresByReason).reduce((sum, count) => sum + count, 0);
  const browserInspectionCandidates = inspected.filter((occurrence) => {
    const destination = occurrence.admission!.destination;
    return destination.browserVisible !== undefined
      || destination.classification === 'unresolved'
      || destination.classification === 'blocked-uninspectable';
  }).length;
  const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
  return {
    rawRows: input.rawRows,
    eligibleRows: input.eligibleRows,
    rejectedAggregatorRows: input.rejectedAggregatorRows,
    survivingAggregatorRows: input.survivingAggregatorRows,
    duplicateOccurrenceIds: input.duplicateOccurrenceIds,
    inspectedCandidates: inspected.length,
    browserInspectionCandidates,
    destinationFailures,
    destinationFailuresByReason: failuresByReason,
    inspectionCoverage: ratio(inspected.length, input.eligibleRows),
    browserInspectionShare: ratio(browserInspectionCandidates, inspected.length),
    destinationFailureRate: ratio(destinationFailures, inspected.length),
    // Bounded migrations deliberately suppress publication until the final
    // complete pass. Measure the underlying decision so that suppression
    // cannot make an otherwise healthy migration deadlock at 90% coverage.
    catalogYield: ratio(inspected.filter(catalogQualified).length, input.rawRows),
    alertYield: ratio(inspected.filter((item) => item.trustedCommunityAlertQualification?.status === 'eligible').length, input.eligibleRows),
  };
}

export function trustedCommunityCircuitBreaches(input: {
  metrics: TrustedCommunitySourceMetrics;
  thresholds?: TrustedCommunityThresholds;
  alertMode: TrustedCommunityAlertMode;
}): string[] {
  const thresholds = input.thresholds ?? SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
  const { metrics } = input;
  const breaches: string[] = [];
  if (metrics.rawRows === 0) breaches.push('parser returned zero rows');
  if (metrics.survivingAggregatorRows > 0) breaches.push(`${metrics.survivingAggregatorRows} aggregator row(s) survived rejection`);
  if (metrics.duplicateOccurrenceIds > 0) breaches.push(`${metrics.duplicateOccurrenceIds} duplicate occurrence identity row(s)`);
  if (metrics.rawRows < thresholds.minimumRawRows) breaches.push(`raw rows ${metrics.rawRows} below ${thresholds.minimumRawRows}`);
  if (metrics.eligibleRows < thresholds.minimumEligibleRows) breaches.push(`eligible rows ${metrics.eligibleRows} below ${thresholds.minimumEligibleRows}`);
  const rateGatesActive = metrics.inspectedCandidates >= thresholds.minimumInspectedCandidates
    && metrics.inspectionCoverage >= thresholds.minimumInspectionCoverage;
  if (rateGatesActive) {
    if (metrics.destinationFailureRate > thresholds.maximumDestinationFailureRate) breaches.push('destination failure rate exceeded');
    if (metrics.browserInspectionShare > thresholds.maximumBrowserInspectionShare) breaches.push('browser inspection share exceeded');
    if (metrics.catalogYield < thresholds.minimumCatalogYield) breaches.push('catalog yield fell below its floor');
    if (input.alertMode !== 'disabled' && metrics.alertYield < thresholds.minimumAlertYield) breaches.push('alert yield fell below its floor');
  }
  return breaches;
}
