import { classifyDestination } from '../destination-verification.js';
import type { ProcessedSnapshot } from '../types.js';
import { trustedCommunityThresholds, type TrustedCommunityBaseline } from './trusted-community-health.js';

export interface TrustedCommunityBaselineDiagnostics {
  rejectedAggregatorRows: number;
  survivingAggregatorRows: number;
  duplicateOccurrenceIds: number;
}

export function trustedCommunityBaselineReport(input: {
  sourceId: string;
  generatedAt?: string;
  sourcePolicyVersion: string;
  processed: ProcessedSnapshot;
  diagnostics: TrustedCommunityBaselineDiagnostics;
}) {
  const eligibleListings = input.processed.listings.filter((listing) => listing.technical !== false);
  const exactRouteShapes = eligibleListings.filter((listing) => {
    const destination = classifyDestination({
      listing,
      reachability: 'implied',
      inspectedAt: input.generatedAt ?? new Date().toISOString(),
    });
    return destination.classification === 'posting-detail' || destination.classification === 'application-form';
  }).length;
  const browserInspectionCandidates = eligibleListings.length - exactRouteShapes;
  const baseline: TrustedCommunityBaseline = {
    rawRows: input.processed.counts.raw,
    eligibleRows: eligibleListings.length,
    destinationFailures: input.diagnostics.rejectedAggregatorRows,
    browserInspectionCandidates,
    catalogAdmissions: eligibleListings.length,
    alertQualifications: exactRouteShapes,
  };
  return {
    schemaVersion: 1,
    sourceId: input.sourceId,
    generatedAt: input.generatedAt,
    sourcePolicyVersion: input.sourcePolicyVersion,
    counts: {
      rawRows: baseline.rawRows,
      technicallyEligibleRows: baseline.eligibleRows,
      rejectedAggregatorRows: input.diagnostics.rejectedAggregatorRows,
      survivingAggregatorRows: input.diagnostics.survivingAggregatorRows,
      duplicateOccurrenceIds: input.diagnostics.duplicateOccurrenceIds,
      exactRouteShapes,
      browserInspectionCandidates,
    },
    rates: {
      technicalYield: baseline.eligibleRows / baseline.rawRows,
      rejectedAggregatorRate: input.diagnostics.rejectedAggregatorRows / baseline.eligibleRows,
      exactRouteShare: exactRouteShapes / baseline.eligibleRows,
      browserInspectionShare: browserInspectionCandidates / baseline.eligibleRows,
    },
    thresholds: trustedCommunityThresholds(baseline),
    thresholdPolicy: {
      rowCountFloor: '70% of this trustworthy baseline',
      rateGateMinimumInspectedCandidates: 100,
      rateGateMinimumInspectionCoverage: 0.9,
      destinationFailureCeiling: 'min(20%, baseline + 5 percentage points)',
      browserInspectionCeiling: 'min(50%, baseline + 10 percentage points)',
      catalogYieldFloor: 'baseline - 10 percentage points',
      alertYieldFloor: 'baseline - 10 percentage points',
    },
  };
}
