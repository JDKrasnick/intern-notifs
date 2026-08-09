import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { probeAshbyBoard } from '../src/sources/ashby-probe.js';

async function main() {
  const args = process.argv.slice(2);
  const out = args.indexOf('--out');
  const destination = out < 0 ? undefined : args[out + 1];
  const boards = (out < 0 ? args : [...args.slice(0, out), ...args.slice(out + 2)]).filter(Boolean);
  if (!boards.length) { console.error('Usage: npm run ashby:probe -- <exact-board-name> [board...] [--out path]'); process.exitCode = 1; return; }
  const results = [];
  for (const board of boards) results.push(await probeAshbyBoard(board));
  const artifact = { probedAt: new Date().toISOString(), retention: 'metadata-only', results };
  if (destination) { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`); }
  console.log(JSON.stringify(artifact, null, 2));
}
void main();
