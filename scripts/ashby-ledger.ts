import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultSources } from '../src/sources/github.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { buildAshbyCandidateLedger, type AshbyCandidateSighting } from '../src/sources/ashby-ledger.js';

async function main() {
  const destination = process.argv[2] ?? 'artifacts/ashby-candidate-ledger.json';
  const sightings: AshbyCandidateSighting[] = [];
  const sourceErrors: Array<{ sourceId: string; error: string }> = [];
  for (const source of defaultSources) {
    try {
      const result = await source.fetch();
      for (const listing of result.listings) sightings.push({
        sourceId: listing.sourceId, company: listing.company, applyUrl: listing.applyUrl, location: listing.location,
      });
    } catch (error) { sourceErrors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const generatedAt = new Date().toISOString();
  const candidates = buildAshbyCandidateLedger(sightings, {
    registeredBoards: reviewedAshbySources.map(({ identity }) => identity.boardKey), observedAt: generatedAt,
  });
  const artifact = {
    generatedAt, discoveryOnly: true,
    admissionRule: 'Board identity must be extracted from an observed jobs.ashbyhq.com URL; ownership and admission require human review.',
    reviewedListings: sightings.length, unregisteredBoards: candidates.length, sourceErrors, candidates,
  };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ output: destination, reviewedListings: sightings.length, unregisteredBoards: candidates.length, sourceErrors: sourceErrors.length }, null, 2));
}
void main();
