import { isGreenhouseApplicationUrl } from '../src/greenhouse-headed.js';
import { isLeverApplicationUrl } from '../src/lever-headed.js';

const catalogUrl = 'https://5dx7gpfa7d.execute-api.us-east-1.amazonaws.com/jobs?status=open&limit=50';

type CatalogJob = { company: string; title: string; applyUrl: string };

function hasContactSurface(html: string) {
  return /(?:first[ _-]?name|given[ _-]?name)/i.test(html)
    && /(?:email|e-mail)/i.test(html)
    && /<input\b/i.test(html);
}

async function fetchPage(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  return { status: response.status, url: response.url, html: await response.text() };
}

const catalogResponse = await fetch(catalogUrl, { signal: AbortSignal.timeout(15_000) });
if (!catalogResponse.ok) throw new Error(`Could not read public catalog: ${catalogResponse.status}`);
const catalog = await catalogResponse.json() as { jobs?: CatalogJob[] };
const uniqueByHost = new Map<string, CatalogJob>();
for (const job of catalog.jobs ?? []) {
  try {
    const host = new URL(job.applyUrl).hostname.toLowerCase();
    if (!uniqueByHost.has(host)) uniqueByHost.set(host, job);
  } catch {
    // A malformed catalog URL is not safe to visit or automate.
  }
}

const catalogHosts = [...uniqueByHost.values()];
const reviewedSamples = catalogHosts.filter((job) => isGreenhouseApplicationUrl(job.applyUrl) || isLeverApplicationUrl(job.applyUrl));
const manualSamples = catalogHosts.filter((job) => !isGreenhouseApplicationUrl(job.applyUrl) && !isLeverApplicationUrl(job.applyUrl));
const samples = [...reviewedSamples, ...manualSamples].slice(0, 16);
const report = await Promise.all(samples.map(async (job) => {
  const reviewed = isGreenhouseApplicationUrl(job.applyUrl)
    ? 'greenhouse'
    : isLeverApplicationUrl(job.applyUrl)
      ? 'lever'
      : 'manual';
  try {
    const page = await fetchPage(job.applyUrl);
    const quickApply = /quick apply with mygreenhouse|autofill with greenhouse/i.test(page.html);
    const contactSurface = hasContactSurface(page.html);
    const passed = reviewed === 'manual'
      || (page.status >= 200 && page.status < 400 && (quickApply || contactSurface));
    return { company: job.company, host: new URL(job.applyUrl).hostname, reviewed, status: page.status, quickApply, contactSurface, passed, url: page.url };
  } catch (error) {
    return { company: job.company, host: new URL(job.applyUrl).hostname, reviewed, passed: reviewed === 'manual', error: error instanceof Error ? error.message : 'request failed', url: job.applyUrl };
  }
}));

console.log(JSON.stringify({ catalogJobs: catalog.jobs?.length ?? 0, distinctHosts: uniqueByHost.size, sampledHosts: report.length, report }, null, 2));
const failedReviewed = report.filter((item) => item.reviewed !== 'manual' && !item.passed);
if (failedReviewed.length) {
  throw new Error(`Reviewed companion surface check failed for: ${failedReviewed.map((item) => item.host).join(', ')}`);
}
