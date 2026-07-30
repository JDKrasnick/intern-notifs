/**
 * Stage 2 of `docs/lever-ownership-verification-plan.md`: the read-only probe,
 * as a command the agent and a reviewer can both run.
 *
 * Usage: npm run lever:probe -- cirrus tomtom [--out artifacts/lever-probes.json]
 *
 * The probe measures a board. It says nothing about who owns it, and it writes
 * no registry entry.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { probeLeverCandidate } from '../src/sources/lever-probe.js';

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const destination = outIndex === -1 ? undefined : args[outIndex + 1];
  const sites = (outIndex === -1 ? args : [...args.slice(0, outIndex), ...args.slice(outIndex + 2)]).filter(Boolean);
  if (!sites.length) {
    console.error('Usage: npm run lever:probe -- <site> [site...] [--out path]');
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const site of sites) results.push(await probeLeverCandidate(site));
  const artifact = { probedAt: new Date().toISOString(), attribution: 'unattributed', results };
  if (destination) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  console.log(JSON.stringify(artifact, null, 2));
}

void main();
