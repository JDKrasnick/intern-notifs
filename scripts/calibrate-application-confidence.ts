import { ApplicationUrlValidationError, assessApplicationPageForListing, sourceRoleAgreement, validateApplicationUrlWithEvidence } from '../src/core/application-url.js';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { applicationUrlRejection } from '../src/sources/quality.js';

const documents = [
  { path: 'README.md', season: 'summer-2026' },
  { path: 'README-Off-Season.md', season: 'offseason-2026' },
];

type Result = {
  document: string;
  row: number;
  company: string;
  role: string;
  outcome: 'high' | 'medium' | 'low' | 'error';
  score?: number;
  agreement?: 'strong' | 'partial' | 'weak';
  title?: string;
  signals?: string[];
  error?: string;
};

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function main() {
  const only = process.argv[2];
  const selected = documents.filter((document) => !only || document.path === only);
  const parsedListings = (await Promise.all(selected.map(async (document) => {
    const url = `https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/${document.path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${document.path}: ${response.status}`);
    return parseInternshipMarkdown(await response.text(), { sourceId: 'simplify-summer-2026', document: document.path, sourceUrl: url, season: document.season });
  }))).flat();
  // Match the GitHub source adapter: an aggregator destination is rejected
  // before the generic scraper runs.
  const listings = parsedListings.filter((listing) => !applicationUrlRejection(listing.applyUrl));
  const results = await mapLimit(listings, 16, async (listing): Promise<Result> => {
    try {
      const { evidence } = await validateApplicationUrlWithEvidence(listing.applyUrl);
      const confidence = assessApplicationPageForListing(listing.title, evidence);
      return { document: listing.document, row: listing.row, company: listing.company, role: listing.title, outcome: confidence.level, score: confidence.score, agreement: sourceRoleAgreement(listing.title, evidence), title: evidence.title, signals: confidence.signals };
    } catch (error) {
      return { document: listing.document, row: listing.row, company: listing.company, role: listing.title, outcome: 'error', error: error instanceof ApplicationUrlValidationError ? error.message : String(error) };
    }
  });
  const counts = <T extends string>(values: T[]) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]));
  const summary = {
    checked: results.length,
    outcome: counts(results.map((result) => result.outcome)),
    agreement: counts(results.filter((result) => result.outcome !== 'error').map((result) => result.agreement!)),
    byOutcomeAgreement: Object.fromEntries(['high', 'medium', 'low'].map((outcome) => [outcome, counts(results.filter((result) => result.outcome === outcome).map((result) => result.agreement!))])),
    genericHighCandidates: results.filter((result) => result.outcome === 'high' && result.agreement === 'weak').slice(0, 30),
    sourceSupportedMediumCandidates: results.filter((result) => result.outcome === 'medium' && result.agreement === 'strong').slice(0, 30),
    errors: results.filter((result) => result.outcome === 'error').slice(0, 50),
  };
  console.log(JSON.stringify(summary, null, 2));
}

await main();
