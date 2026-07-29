import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { collectManifestViolations, nodeManifestFs } from '../src/sources/greenhouse-manifest.js';

const violations = collectManifestViolations(reviewedGreenhouseSources, nodeManifestFs());
if (violations.length) {
  console.error('Greenhouse registry-to-fixture manifest check failed:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Greenhouse manifest OK (${reviewedGreenhouseSources.length} reviewed board(s)).`);
}
