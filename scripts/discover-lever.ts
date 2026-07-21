import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sourceQualityPolicies } from '../src/sources/quality.js';

interface Employer { canonicalName: string; aliases?: string[]; }
interface Inventory { companies: Employer[]; }
interface LeverPosting { text?: string; applyUrl?: string; }

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function sites(employer: Employer) { return [...new Set([employer.canonicalName, ...(employer.aliases ?? [])].map(slug).filter(Boolean))]; }
function directApply(site: string, url: string) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'jobs.lever.co' && new RegExp(`^/${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/apply/?$`).test(parsed.pathname); } catch { return false; }
}

async function main() {
  const destination = process.argv[2] ?? 'artifacts/lever-review-candidates.json';
  const inventory = JSON.parse(await readFile('EMPLOYERS.json', 'utf8')) as Inventory;
  const admittedSites = new Set(sourceQualityPolicies.filter((policy) => policy.sourceClass === 'lever').map((policy) => policy.leverSite));
  const candidates: Array<{ employer: string; site: string; endpoint: string; roleCount: number; sampleApplicationUrls: string[]; status: 'needs-human-approval' }> = [];
  for (const employer of inventory.companies) {
    for (const site of sites(employer)) {
      if (admittedSites.has(site)) continue;
      const endpoint = `https://api.lever.co/v0/postings/${site}?mode=json`;
      try {
        const response = await fetch(endpoint);
        if (!response.ok) continue;
        const postings = await response.json() as LeverPosting[];
        if (!Array.isArray(postings)) continue;
        const applicationUrls = postings.map((posting) => posting.applyUrl).filter((url): url is string => Boolean(url) && directApply(site, url));
        if (!applicationUrls.length) continue;
        candidates.push({ employer: employer.canonicalName, site, endpoint, roleCount: applicationUrls.length, sampleApplicationUrls: applicationUrls.slice(0, 3), status: 'needs-human-approval' });
      } catch { /* discovery is best-effort; failures stay out of the review artifact */ }
    }
  }
  const artifact = { generatedAt: new Date().toISOString(), rosterCount: inventory.companies.length, discoveryOnly: true, admissionRule: 'A human must approve an employer-hosted direct application URL before this candidate may be registered as a production source.', candidates };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ rosterCount: artifact.rosterCount, candidates: candidates.length, output: destination }, null, 2));
}

void main();
