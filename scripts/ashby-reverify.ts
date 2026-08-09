import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AshbyOwnershipEvidence } from '../src/sources/ashby-evidence.js';
import { ASHBY_EVIDENCE_ROOT } from '../src/sources/ashby-manifest.js';
import { recheckAshbyEvidence } from '../src/sources/ashby-reverify.js';

async function main() {
  const root = process.argv[2] ?? ASHBY_EVIDENCE_ROOT;
  if (!existsSync(root)) { console.error(`No evidence directory at ${root}`); process.exitCode = 1; return; }
  const boards = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(`${root}/${e.name}/evidence.json`)).map((e) => e.name).sort();
  let failures = 0;
  for (const board of boards) {
    const evidence = JSON.parse(readFileSync(`${root}/${board}/evidence.json`, 'utf8')) as AshbyOwnershipEvidence;
    const result = await recheckAshbyEvidence(evidence);
    if (result.state !== 'ok') { console.log(`${board.padEnd(20)} ${result.state}`); failures += 1; continue; }
    console.log(`${board.padEnd(20)} ${result.stillProven ? 'proven' : 'missing'} ${result.finalUrl}`);
    if (!result.stillProven) failures += 1;
  }
  if (failures) { console.error(`\n${failures} board(s) require human re-review; no registry changes were made.`); process.exitCode = 1; }
}
void main();
