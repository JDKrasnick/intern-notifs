import { reviewedLeverSources } from '../src/sources/lever-config.js';
import { collectLeverManifestViolations, nodeLeverManifestFs, summariseLeverManifest } from '../src/sources/lever-manifest.js';

const options = { fs: nodeLeverManifestFs() };
const violations = collectLeverManifestViolations(reviewedLeverSources, options);
const summary = summariseLeverManifest(reviewedLeverSources, options);

if (violations.length) {
  console.error('Lever registry-to-evidence manifest check failed:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Lever manifest OK (${summary.reviewed} reviewed board(s): ${summary.published} published, ${summary.shadow} shadow; ${summary.agentVerified} agent-verified, ${summary.legacyReview} legacy-review).`);
}
if (summary.pendingAdmission.length) {
  console.log(`Verified and pending admission: ${summary.pendingAdmission.join(', ')}`);
}
