import { Poller } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import type { EmployerCategory } from '../src/core/employers.js';

type Fixture = { company: string; expected: EmployerCategory };

// This deliberately exercises the production path: GitHub Markdown adapter →
// Markdown parser → poller → internship store. The fetch is mocked only so the
// audit stays deterministic and never makes an external request.
const fixtures: Fixture[] = [
  { company: 'Google', expected: 'faang' },
  { company: 'Amazon', expected: 'faang' },
  { company: 'Apple', expected: 'faang' },
  { company: 'Meta', expected: 'faang' },
  { company: 'Netflix', expected: 'faang' },
  { company: 'Brex', expected: 'startup' },
  { company: 'Notion', expected: 'startup' },
  { company: 'Plaid', expected: 'startup' },
  { company: 'Vercel', expected: 'startup' },
  { company: 'Rippling', expected: 'startup' },
  { company: 'Scale AI', expected: 'startup' },
  { company: 'Supabase', expected: 'startup' },
  { company: 'Vanta', expected: 'startup' },
  { company: 'Zapier', expected: 'startup' },
  { company: 'Sentry.io', expected: 'startup' },
  { company: 'Microsoft', expected: 'normal' },
  { company: 'NVIDIA', expected: 'normal' },
  { company: 'Datadog', expected: 'normal' },
  { company: 'Adobe', expected: 'normal' },
  { company: 'Bloomberg', expected: 'normal' },
  { company: 'Shopify', expected: 'normal' },
  { company: 'Cisco', expected: 'normal' },
  { company: 'Oracle', expected: 'normal' },
  { company: 'IBM', expected: 'normal' },
  { company: 'Zoom', expected: 'normal' }
];

function auditMarkdown() {
  const rows = fixtures.map((fixture, index) => (
    `| ${fixture.company} | Software Engineering Intern | Remote | [Apply](https://audit.example.test/jobs/${index + 1}) | Open |`
  ));
  return [
    '| Company | Role | Location | Apply | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows
  ].join('\n');
}

async function main() {
  const adapter = new GitHubMarkdownAdapter({
    id: 'employer-classification-audit',
    owner: 'audit',
    repo: 'internships',
    documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
    fetchImpl: async () => new Response(auditMarkdown(), { headers: { etag: '"employer-audit"' } })
  });
  const store = new MemoryInternshipStore();
  const report = await new Poller([adapter], store, () => new Date('2026-07-19T00:00:00.000Z')).poll();
  const errors = [
    ...(report.fetchedSources === 1 ? [] : [`expected one fetched source, got ${report.fetchedSources}`]),
    ...(report.failures.length === 0 ? [] : report.failures),
    ...(store.jobs.size === fixtures.length ? [] : [`expected ${fixtures.length} stored jobs, got ${store.jobs.size}`]),
    ...fixtures.flatMap((fixture) => {
      const job = [...store.jobs.values()].find((candidate) => candidate.company === fixture.company);
      if (!job) return [`${fixture.company}: missing from stored jobs`];
      if (job.employerCategory !== fixture.expected) return [`${fixture.company}: expected ${fixture.expected}, got ${job.employerCategory ?? 'unset'}`];
      if (job.sourceReferences[0]?.sourceId !== adapter.id) return [`${fixture.company}: did not retain the adapter source reference`];
      return [];
    })
  ];
  if (errors.length > 0) throw new Error(`Employer classification audit failed:\n${errors.join('\n')}`);

  const categories = Object.fromEntries(
    ['faang', 'startup', 'normal'].map((category) => [category, fixtures.filter((fixture) => fixture.expected === category).length])
  );
  console.log(JSON.stringify({ audited: fixtures.length, categories, pipeline: 'GitHub Markdown adapter -> parser -> poller -> store' }));
}

await main();
