import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { classifyDestination } from '../src/destination-verification.js';
import { defaultSources } from '../src/sources/github.js';
import { sourceAdmissionPolicy } from '../src/sources/trust-policy.js';
import {
  trustedCommunityThresholds,
  type TrustedCommunityBaseline,
} from '../src/sources/trusted-community-health.js';

const SOURCE_ID = 'simplify-summer-2026';
const REPORT_PATH = resolve('docs/trusted-community/simplify-summer-2026-baseline.json');

const source = defaultSources.find((candidate) => candidate.id === SOURCE_ID);
if (!source) throw new Error(`${SOURCE_ID} is not configured`);
const sourcePolicy = sourceAdmissionPolicy(SOURCE_ID);
if (sourcePolicy.trust !== 'trusted-community') throw new Error(`${SOURCE_ID} has no trusted-community policy`);

const result = await source.fetch();
const processed = result.processed;
if (!processed) throw new Error(`${SOURCE_ID} did not return a processed snapshot`);
const exactRouteShapes = processed.listings.filter((listing) => {
  const destination = classifyDestination({ listing, reachability: 'implied', inspectedAt: result.checkpoint.lastSuccessAt ?? new Date().toISOString() });
  return destination.classification === 'posting-detail' || destination.classification === 'application-form';
}).length;
const diagnostics = result.trustedCommunityDiagnostics ?? {
  rejectedAggregatorRows: result.rejectedApplicationUrls?.filter((item) => item.reason.includes('aggregator')).length ?? 0,
  survivingAggregatorRows: 0,
  duplicateOccurrenceIds: 0,
};
const baseline: TrustedCommunityBaseline = {
  rawRows: processed.counts.raw,
  eligibleRows: processed.counts.eligible,
  destinationFailures: diagnostics.rejectedAggregatorRows,
  browserInspectionCandidates: processed.counts.eligible - exactRouteShapes,
  catalogAdmissions: processed.counts.eligible,
  alertQualifications: exactRouteShapes,
};
const report = {
  schemaVersion: 1,
  sourceId: SOURCE_ID,
  generatedAt: result.checkpoint.lastSuccessAt,
  sourcePolicyVersion: sourcePolicy.version,
  counts: {
    rawRows: processed.counts.raw,
    technicallyEligibleRows: processed.counts.eligible,
    rejectedAggregatorRows: diagnostics.rejectedAggregatorRows,
    survivingAggregatorRows: diagnostics.survivingAggregatorRows,
    duplicateOccurrenceIds: diagnostics.duplicateOccurrenceIds,
    exactRouteShapes,
    browserInspectionCandidates: processed.counts.eligible - exactRouteShapes,
  },
  rates: {
    technicalYield: processed.counts.eligible / processed.counts.raw,
    rejectedAggregatorRate: diagnostics.rejectedAggregatorRows / processed.counts.eligible,
    exactRouteShare: exactRouteShapes / processed.counts.eligible,
    browserInspectionShare: (processed.counts.eligible - exactRouteShapes) / processed.counts.eligible,
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

if (process.argv.includes('--record')) {
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(report, null, 2));
