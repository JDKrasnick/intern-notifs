#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMetadataAcquirer, metadataApiRoute } from '../src/metadata-acquisition.js';
import { compareMetadataCohort, metadataFieldOutcomes } from '../src/metadata-audit.js';
import { extractPostingMetadataEvidence, ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import type { Internship, ProviderIdentity } from '../src/types.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const endpoint = process.env.CATALOG_API_URL ?? 'https://intern-notifs.jdkrasnick.workers.dev';
const path = option('--catalog');
const jobs: Internship[] = path ? JSON.parse(await readFile(path, 'utf8')) as Internship[] : [];
if (!path) {
  let cursor: string | undefined; const cursors = new Set<string>();
  do {
    const url = new URL('/jobs', endpoint); url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    const page = await response.json() as { jobs: Internship[]; cursor?: string };
    jobs.push(...page.jobs); cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 200) throw new Error('Catalog pagination did not converge');
      cursors.add(cursor);
    }
  } while (cursor);
}
const current = [...new Map(jobs.map((job) => [job.jobId, job])).values()];
const count = (predicate: (job: Internship) => boolean) => current.filter(predicate).length;
const baselinePath = option('--baseline');
const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) as Internship[] : undefined;
const reportPath = option('--report');
const previous = reportPath ? await readFile(reportPath, 'utf8').then((value) => JSON.parse(value) as { acquisitions?: Array<Record<string, unknown>> }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error; return {} as { acquisitions?: Array<Record<string, unknown>> };
}) : undefined;
const acquisitions = new Map((previous?.acquisitions ?? []).map((row) => [String(row.jobId), row]));
const limit = Number(option('--api-limit') ?? 0);
if (!Number.isInteger(limit) || limit < 0 || limit > 2000) throw new Error('--api-limit must be an integer from 0 to 2000');
const acquire = createMetadataAcquirer();
let attempted = 0;
const summary = () => ({ observedAt: new Date().toISOString(), extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
  publicCatalog: { roles: current.length, withPay: count((job) => !!job.compensation?.raw), withMetadata: count((job) => !!job.roleMetadata),
    withPublishedDate: count((job) => !!job.employerPublishedAt), withDeadline: count((job) => !!job.applicationDeadline),
    withWorkMode: count((job) => !!job.workMode && job.workMode !== 'unspecified'), withGraduationWindow: count((job) => !!job.graduationWindow) },
  ...(baseline ? { fixedCohort: compareMetadataCohort(baseline, current) } : {}),
  // API results measure acquisition/extraction, not deployed projection or recall.
  acquisitionDenominator: acquisitions.size, disclosureRecall: null, acquisitions: [...acquisitions.values()] });
const save = async () => { if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(`${reportPath}.tmp`, JSON.stringify(summary(), null, 2));
  await rename(`${reportPath}.tmp`, reportPath);
} };
for (const job of current) {
  if (attempted >= limit) break;
  const prior = acquisitions.get(job.jobId);
  if (prior?.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION && !args.includes('--retry')
    && !(args.includes('--retry-failed') && prior.outcome !== 'acquired')) continue;
  const posting = job.postingIdentity;
  const reference = job.sourceReferences[0];
  const identity: ProviderIdentity = { provider: posting?.provider ?? 'unknown', tenant: posting?.tenant,
    postingId: posting?.providerPostingId, sourceId: reference?.sourceId ?? 'public-audit', sourceUrl: job.applyUrl };
  if (!metadataApiRoute(identity, job.applyUrl)) continue;
  attempted += 1;
  const started = Date.now(); const result = await acquire(identity, job.applyUrl);
  const observedAt = new Date().toISOString();
  const evidence = result?.artifact ? extractPostingMetadataEvidence({ artifact: result.artifact, sourceClass: 'official-api',
    sourceId: identity.sourceId, sourceUrl: result.sourceUrl, observedAt, exactPosting: true }) : [];
  acquisitions.set(job.jobId, { jobId: job.jobId, provider: identity.provider, method: result?.method, sourceUrl: result?.sourceUrl,
    outcome: result?.outcome, status: result?.status, bytes: result?.bytes, elapsedMs: Date.now() - started,
    observedAt, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash: evidence[0]?.artifactHash,
    fields: metadataFieldOutcomes({ evidence, acquired: !!result?.artifact, complete: !!result?.artifact }),
    compensationRanges: evidence.flatMap((item) => item.compensationRanges ?? []) });
  await save();
  if (attempted % 20 === 0) console.error(JSON.stringify({ attempted, retained: acquisitions.size }));
}
await save();
const result = summary();
console.log(JSON.stringify({ ...result, fixedCohort: result.fixedCohort ? { denominator: result.fixedCohort.denominator, counts: result.fixedCohort.counts } : undefined,
  acquisitions: undefined, apiOutcomes: [...acquisitions.values()].reduce<Record<string, number>>((counts, row) => {
    const key = `${row.method}/${row.outcome}`; counts[key] = (counts[key] ?? 0) + 1; return counts;
  }, {}) }, null, 2));
