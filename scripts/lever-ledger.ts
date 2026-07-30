/**
 * Stage 1 of `docs/lever-ownership-verification-plan.md`: assemble the Lever
 * candidate ledger from evidence the catalog already holds.
 *
 * Every candidate arrives with a site string read out of an observed job URL, a
 * maintainer-written employer name, and a count of the roles it would
 * contribute. Nothing here is derived from a company name, and nothing here
 * publishes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultSources } from '../src/sources/github.js';
import { buildLeverCandidateLedger, type LeverCandidateSighting } from '../src/sources/lever-ledger.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';

async function main() {
  const destination = process.argv[2] ?? 'artifacts/lever-candidate-ledger.json';
  const sightings: LeverCandidateSighting[] = [];
  const sourceErrors: Array<{ sourceId: string; error: string }> = [];

  for (const source of defaultSources) {
    try {
      const result = await source.fetch();
      for (const listing of result.listings) {
        sightings.push({ sourceId: listing.sourceId, company: listing.company, applyUrl: listing.applyUrl });
      }
    } catch (error) {
      sourceErrors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const candidates = buildLeverCandidateLedger(sightings, {
    registeredSites: reviewedLeverSources.map((source) => source.site),
  });
  const artifact = {
    generatedAt: new Date().toISOString(),
    discoveryOnly: true,
    admissionRule: 'A candidate is admissible only via an ownership evidence record in state ownership-verified. A live API response is never ownership evidence.',
    reviewedListings: sightings.length,
    unregisteredSites: candidates.length,
    referencedListings: candidates.reduce((total, candidate) => total + candidate.eligibleListings, 0),
    ...(sourceErrors.length ? { sourceErrors } : {}),
    candidates,
  };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({
    reviewedListings: artifact.reviewedListings,
    unregisteredSites: artifact.unregisteredSites,
    referencedListings: artifact.referencedListings,
    sourceErrors: sourceErrors.length,
    output: destination,
  }, null, 2));
}

void main();
