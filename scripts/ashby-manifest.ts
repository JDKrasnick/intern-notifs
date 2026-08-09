import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { collectAshbyManifestViolations, nodeAshbyManifestFs, summariseAshbyManifest } from '../src/sources/ashby-manifest.js';

const violations = collectAshbyManifestViolations(reviewedAshbySources, { fs: nodeAshbyManifestFs() });
if (violations.length) {
  console.error('Ashby admission manifest failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  const summary = summariseAshbyManifest();
  console.log(`Ashby manifest OK (${summary.reviewed} reviewed: ${summary.shadow} shadow, ${summary.published} published).`);
}
