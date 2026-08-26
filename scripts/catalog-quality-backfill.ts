const args = new Set(process.argv.slice(2));
const value = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const apply = args.has('--apply');
const repairToken = args.has('--repair-token') ? value('--repair-token') : undefined;
const expectedChanged = args.has('--expected-changed') ? Number(value('--expected-changed')) : undefined;
if (apply && (!repairToken || !Number.isSafeInteger(expectedChanged))) {
  throw new Error('--apply requires --repair-token and --expected-changed');
}
const baseUrl = process.env.CATALOG_API_URL ?? 'https://intern-notifs.jdkrasnick.workers.dev';
const secret = process.env.OPERATIONS_SHARED_SECRET;
if (!secret) throw new Error('OPERATIONS_SHARED_SECRET is required');
const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/internal/catalog-quality-backfill`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Operations-Key': secret },
  body: JSON.stringify({ apply, repairToken, expectedChanged }),
});
const body = await response.text();
console.log(body);
if (!response.ok) process.exitCode = 1;
