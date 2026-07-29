import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_PAGES = 100;
const knownDynamicPages = ['https://www.ycombinator.com/companies', 'https://www.ycombinator.com/jobs'];

function configuredPages() {
  const additional = (process.env.FIRECRAWL_DISCOVERY_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return [...new Set([...knownDynamicPages, ...additional])].slice(0, MAX_PAGES);
}

async function main() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY is required and must be supplied only by the Actions secret');
  const destination = process.argv[2] ?? 'artifacts/firecrawl-discovery-review.json';
  const pages = configuredPages();
  const response = await fetch('https://api.firecrawl.dev/v2/batch/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: pages, formats: ['markdown', 'links'] })
  });
  if (!response.ok) throw new Error(`Firecrawl batch submission failed (${response.status})`);
  const submission = await response.json();
  const artifact = {
    generatedAt: new Date().toISOString(),
    discoveryOnly: true,
    pageLimit: MAX_PAGES,
    requestedPages: pages,
    admissionRule: 'No Firecrawl or YC result is a production source. A human must approve an employer-hosted HTTPS application URL before admission.',
    firecrawlBatch: submission
  };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ requestedPages: pages.length, output: destination, discoveryOnly: true }, null, 2));
}

void main();
