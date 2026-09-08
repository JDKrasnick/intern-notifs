import { recheckTrustedCatalogProbes } from '../src/trusted-catalog-probes.js';

function option(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
async function main() {
  if (process.argv.includes('--help')) { console.log('Usage: npm run probes:trusted-catalog [--api-url https://…] [--timeout-ms 10000]\n\nRead-only: fetches the three official ATS records and public /jobs/{id}; writes nothing and requires no credentials.'); return; }
  const timeoutText = option('--timeout-ms'); const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
  if (timeoutText !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs! < 100 || timeoutMs! > 30_000)) { console.error('--timeout-ms must be an integer from 100 to 30000'); process.exitCode = 1; return; }
  const results = await recheckTrustedCatalogProbes({ apiUrl: option('--api-url'), timeoutMs });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, results }, null, 2));
  if (results.some((result) => result.state !== 'ok')) process.exitCode = 1;
}
void main();
