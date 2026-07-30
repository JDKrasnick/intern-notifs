/**
 * Stage 5: recheck every committed ownership evidence record against the
 * employer's page as it is today.
 *
 * `missing` fails the run — the page no longer proves what the record claims, so
 * the board belongs in shadow until a person looks. `link-only` does not fail:
 * the link is still there, but the recorded markup no longer matches it, which
 * usually means the page changed or the agent paraphrased its own evidence. Both
 * are worth reading, neither is grounds for demotion on its own.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { LEVER_EVIDENCE_ROOT } from '../src/sources/lever-manifest.js';
import { recheckLeverEvidence } from '../src/sources/lever-reverify.js';
import type { LeverOwnershipEvidence } from '../src/sources/lever-evidence.js';

async function main() {
  const root = process.argv[2] ?? LEVER_EVIDENCE_ROOT;
  if (!existsSync(root)) {
    console.error(`No evidence directory at ${root}`);
    process.exitCode = 1;
    return;
  }
  const sites = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${root}/${entry.name}/evidence.json`))
    .map((entry) => entry.name)
    .sort();

  let failures = 0;
  for (const site of sites) {
    const evidence = JSON.parse(readFileSync(`${root}/${site}/evidence.json`, 'utf8')) as LeverOwnershipEvidence;
    if (evidence.state !== 'ownership-verified') {
      console.log(`${site.padEnd(20)} skipped        state=${evidence.state}`);
      continue;
    }
    const result = await recheckLeverEvidence(evidence);
    if (result.state !== 'ok') {
      console.log(`${site.padEnd(20)} ${result.state.padEnd(14)} ${result.violations?.join('; ') ?? result.status ?? ''}`);
      if (result.state === 'malformed-record') failures += 1;
      continue;
    }
    console.log(`${site.padEnd(20)} ${result.fidelity.padEnd(14)} ${result.firstPartyEvidenceUrl}`);
    if (!result.stillProven) failures += 1;
  }
  if (failures) {
    console.error(`\n${failures} board(s) no longer supported by their recorded evidence. Demote to shadow and re-verify.`);
    process.exitCode = 1;
  }
}

void main();
