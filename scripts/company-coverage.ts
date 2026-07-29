import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { companyWeights } from '../src/config/weights.js';
import { defaultSources } from '../src/sources/index.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { greenhouseAdapters } from '../src/sources/greenhouse.js';
import { approvedLeverSourceConfigs } from '../src/sources/lever.js';

type DirectProvider = 'greenhouse' | 'lever';
type DirectStatus = 'published' | 'shadow';

interface DirectSource {
  provider: DirectProvider;
  sourceId: string;
  status: DirectStatus;
}

interface WorkingCompany {
  companyId: string;
  displayName: string;
  aliases: Set<string>;
  sourceIds: Set<string>;
  seasons: Set<string>;
  activeListingCount: number;
  seed: boolean;
  directSources: DirectSource[];
}

const suffixes = new Set([
  'co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited',
  'llc', 'ltd', 'plc',
]);

const canonicalAliases: Record<string, string> = {
  'amazon web services': 'Amazon',
  'aws': 'Amazon',
  'byte dance': 'ByteDance',
  'deepmind': 'Google',
  'facebook': 'Meta',
  'google deepmind': 'Google',
  'hudson river trading': 'HRT',
  'jump trading': 'Jump',
  'palantir': 'Palantir Technologies',
  'tiktok': 'ByteDance',
};

export function normalizeCompanyName(value: string): string {
  const withoutDecorators = value
    .normalize('NFKC')
    .replace(/^[^\p{L}\p{N}]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = withoutDecorators
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (terms.length > 1 && suffixes.has(terms.at(-1)!)) terms.pop();
  return terms.join(' ');
}

function canonicalName(value: string): string {
  const key = normalizeCompanyName(value);
  return canonicalAliases[key] ?? value
    .normalize('NFKC')
    .replace(/^[^\p{L}\p{N}]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function companyId(value: string): string {
  return normalizeCompanyName(canonicalName(value)).replace(/\s+/g, '-');
}

function generatedAtArgument(): string {
  const index = process.argv.indexOf('--generated-at');
  const supplied = index >= 0 ? process.argv[index + 1] : undefined;
  const value = supplied ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(value))) throw new Error('--generated-at must be an ISO timestamp');
  return new Date(value).toISOString();
}

function getCompany(companies: Map<string, WorkingCompany>, name: string): WorkingCompany {
  const displayName = canonicalName(name);
  const id = companyId(displayName);
  if (!id) throw new Error(`Company name cannot be normalized: ${JSON.stringify(name)}`);
  const existing = companies.get(id);
  if (existing) {
    if (name.trim() && name.trim() !== existing.displayName) existing.aliases.add(name.trim());
    return existing;
  }
  const company: WorkingCompany = {
    companyId: id,
    displayName,
    aliases: new Set(name.trim() === displayName ? [] : [name.trim()]),
    sourceIds: new Set(),
    seasons: new Set(),
    activeListingCount: 0,
    seed: false,
    directSources: [],
  };
  companies.set(id, company);
  return company;
}

async function main() {
  const generatedAt = generatedAtArgument();
  const companies = new Map<string, WorkingCompany>();
  const sourceRows: Array<{
    sourceId: string;
    activeListingCount: number;
    publicationStatus: 'published' | 'shadow';
    evidenceUrls: string[];
  }> = [];

  for (const source of defaultSources) {
    const result = await source.fetch();
    sourceRows.push({
      sourceId: source.id,
      activeListingCount: result.listings.length,
      publicationStatus: 'published',
      evidenceUrls: [...new Set(result.listings.map((listing) => listing.sourceUrl))].sort(),
    });
    for (const listing of result.listings) {
      const company = getCompany(companies, listing.company);
      company.activeListingCount += 1;
      company.sourceIds.add(source.id);
      company.seasons.add(listing.season);
    }
  }

  for (const reviewedSource of reviewedGreenhouseSources) {
    const [source] = greenhouseAdapters([reviewedSource]);
    const result = await source.fetch();
    sourceRows.push({
      sourceId: source.id,
      activeListingCount: result.listings.length,
      publicationStatus: reviewedSource.status,
      evidenceUrls: [...new Set([reviewedSource.careersUrl, ...result.listings.map((listing) => listing.sourceUrl)])].sort(),
    });
    for (const listing of result.listings) {
      const company = getCompany(companies, listing.company);
      company.activeListingCount += 1;
      company.sourceIds.add(source.id);
      company.seasons.add(listing.season);
    }
  }

  for (const name of Object.keys(companyWeights.weights)) {
    getCompany(companies, name).seed = true;
  }

  for (const source of approvedLeverSourceConfigs) {
    const company = getCompany(companies, source.company);
    company.directSources.push({ provider: 'lever', sourceId: source.id, status: 'published' });
  }

  for (const source of reviewedGreenhouseSources) {
    const company = getCompany(companies, source.displayName);
    for (const alias of source.aliases) company.aliases.add(alias);
    company.directSources.push({ provider: 'greenhouse', sourceId: source.id, status: source.status });
  }

  const records = [...companies.values()]
    .map((company) => {
      const directSources = company.directSources.sort((a, b) =>
        `${a.provider}:${a.sourceId}`.localeCompare(`${b.provider}:${b.sourceId}`),
      );
      const coverageState = directSources.some((source) => source.status === 'published')
        ? 'direct-published'
        : directSources.some((source) => source.status === 'shadow')
          ? 'direct-shadow'
          : company.activeListingCount > 0
            ? 'feed-observed'
            : 'candidate-only';
      return {
        companyId: company.companyId,
        displayName: company.displayName,
        aliases: [...company.aliases].filter(Boolean).sort(),
        coverageState,
        internshipEvidence: {
          status: company.activeListingCount > 0 ? 'current' : 'unknown',
          activeListingCount: company.activeListingCount,
          sourceIds: [...company.sourceIds].sort(),
          seasons: [...company.seasons].sort(),
        },
        directSources,
        candidateSources: [
          ...(company.seed ? ['company-weights'] : []),
          ...(company.activeListingCount > 0 ? ['configured-feeds'] : []),
        ],
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const counts = {
    companies: records.length,
    internshipObserved: records.filter((company) => company.internshipEvidence.status === 'current').length,
    directPublished: records.filter((company) => company.coverageState === 'direct-published').length,
    directShadow: records.filter((company) => company.coverageState === 'direct-shadow').length,
    feedObservedOnly: records.filter((company) => company.coverageState === 'feed-observed').length,
    candidateOnly: records.filter((company) => company.coverageState === 'candidate-only').length,
    activeListingObservations: records.reduce((total, company) => total + company.internshipEvidence.activeListingCount, 0),
  };
  const snapshot = {
    schemaVersion: 1,
    generatedAt,
    methodology: 'Configured live technical-internship feeds plus reviewed direct ATS registries and maintained tech-company seeds.',
    counts,
    sourceRows: sourceRows.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    companies: records,
  };
  const summary = {
    schemaVersion: snapshot.schemaVersion,
    generatedAt,
    methodology: snapshot.methodology,
    counts,
    companies: records.map(({ companyId, displayName, coverageState, internshipEvidence, directSources }) => ({
      companyId,
      displayName,
      coverageState,
      activeListingCount: internshipEvidence.activeListingCount,
      directProviders: [...new Set(directSources.map((source) => source.provider))],
    })),
  };

  await writeFile(resolve('coverage/companies.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(
    resolve('coverage/summary.ts'),
    `// Generated by scripts/company-coverage.ts. Do not edit by hand.\n`
      + `export interface CompanyCoverageListItem {\n`
      + `  companyId: string;\n`
      + `  displayName: string;\n`
      + `  coverageState: 'direct-published' | 'direct-shadow' | 'feed-observed' | 'candidate-only';\n`
      + `  activeListingCount: number;\n`
      + `  directProviders: Array<'greenhouse' | 'lever'>;\n`
      + `}\n`
      + `export interface CompanyCoverageSnapshot {\n`
      + `  schemaVersion: number;\n`
      + `  generatedAt: string;\n`
      + `  methodology: string;\n`
      + `  counts: { companies: number; internshipObserved: number; directPublished: number; directShadow: number; feedObservedOnly: number; candidateOnly: number; activeListingObservations: number };\n`
      + `  companies: CompanyCoverageListItem[];\n`
      + `}\n`
      + `export const companyCoverage: CompanyCoverageSnapshot = ${JSON.stringify(summary, null, 2)};\n`,
  );
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

await main();
