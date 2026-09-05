import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultSources } from '../src/sources/github.js';
import { trustedCommunityBaselineReport } from '../src/sources/trusted-community-baseline.js';
import { sourceAdmissionPolicy } from '../src/sources/trust-policy.js';

const SOURCE_ID = 'simplify-summer-2026';
const REPORT_PATH = resolve('docs/trusted-community/simplify-summer-2026-baseline.json');

const source = defaultSources.find((candidate) => candidate.id === SOURCE_ID);
if (!source) throw new Error(`${SOURCE_ID} is not configured`);
const sourcePolicy = sourceAdmissionPolicy(SOURCE_ID);
if (sourcePolicy.trust !== 'trusted-community') throw new Error(`${SOURCE_ID} has no trusted-community policy`);

const result = await source.fetch();
const processed = result.processed;
if (!processed) throw new Error(`${SOURCE_ID} did not return a processed snapshot`);
const diagnostics = result.trustedCommunityDiagnostics ?? {
  rejectedAggregatorRows: result.rejectedApplicationUrls?.filter((item) => item.reason.includes('aggregator')).length ?? 0,
  survivingAggregatorRows: 0,
  duplicateOccurrenceIds: 0,
};
const report = trustedCommunityBaselineReport({
  sourceId: SOURCE_ID,
  generatedAt: result.checkpoint.lastSuccessAt,
  sourcePolicyVersion: sourcePolicy.version,
  processed,
  diagnostics,
});

if (process.argv.includes('--record')) {
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(report, null, 2));
