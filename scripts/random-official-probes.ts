import { runRandomOfficialProbes } from '../src/random-official-probes.js';
const value = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
async function main() {
  if (process.argv.includes('--help')) { console.log('Usage: tsx scripts/random-official-probes.ts [--count 10] [--seed receipt-seed] [--api-url URL] [--timeout-ms 12000]\nRead-only: samples public roles with exactly one Greenhouse, Lever, or Ashby official occurrence.'); return; }
  const count = value('--count'); const timeout = value('--timeout-ms');
  const run = await runRandomOfficialProbes({ apiUrl: value('--api-url'), seed: value('--seed'), ...(count ? { count: Number(count) } : {}), ...(timeout ? { timeoutMs: Number(timeout) } : {}) });
  console.log(JSON.stringify(run, null, 2)); if (run.selected < (count ? Number(count) : 10) || run.results.some(result => result.state !== 'ok')) process.exitCode = 1;
}
void main();
