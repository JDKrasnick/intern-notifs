import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { StructuredCareerSourceConnector, type StructuredSourceConfig } from '../src/sources/structured/connector.js';
import type { HostResolver } from '../src/employer/safe-network.js';

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/structured/${name}`, import.meta.url)), 'utf8');
const resolver: HostResolver = { resolve: async () => ['93.184.216.34'] };
const now = () => new Date('2026-08-26T10:00:00Z');

const config = (overrides: Partial<StructuredSourceConfig> = {}): StructuredSourceConfig => ({
  id: 'structured-acme', kind: 'json-ld', url: 'https://careers.acme.example/jobs',
  employer: { id: 'employer-acme', name: 'Acme' },
  allowedApplicationHosts: [{ host: 'careers.acme.example', pathPrefix: '/jobs' }],
  ...overrides,
});

function routes(values: Record<string, string | Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const value = values[url];
    if (value instanceof Response) return value;
    if (typeof value === 'string') return new Response(value, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
}

function jobPage(id: string, applyUrl = `https://careers.acme.example/jobs/${id}/apply`, title = `Software Intern ${id}`): string {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', identifier: id, title, url: applyUrl,
  })}</script>`;
}

describe('StructuredCareerSourceConnector', () => {
  it('maps bounded JobPosting JSON-LD with official structured provenance and a complete checkpoint', async () => {
    const html = await fixture('json-ld.html');
    const connector = new StructuredCareerSourceConnector({ source: config(), resolver, fetcher: routes({ 'https://careers.acme.example/jobs': html }), now });
    const snapshot = await connector.fetch();

    expect(snapshot).toMatchObject({ sourceId: 'structured-acme', outcome: 'changed', complete: true, rawCount: 1 });
    expect(snapshot.postings[0]).toMatchObject({
      provenance: 'official-structured', externalId: 'ACME:intern-42', title: 'Software Engineering Intern',
      locations: ['New York, NY, US'], applyUrl: 'https://careers.acme.example/jobs/intern-42/apply',
      sourceState: 'open', compensationText: 'USD 30-40 per HOUR', publishedAt: '2026-08-20T12:30:00.000Z',
      employer: { id: 'employer-acme', name: 'Acme', authority: 'reviewed-registry' },
    });
    expect(snapshot.checkpoint.activeExternalIds).toEqual(['ACME:intern-42']);
    expect(snapshot.checkpoint).toMatchObject({ successfulFetches: 1, lastRawCount: 1, lastRowCount: 1 });

    const unchanged = await connector.fetch(snapshot.checkpoint);
    expect(unchanged.outcome).toBe('unchanged');
    expect(unchanged.postings).toHaveLength(1);
    expect(unchanged.checkpoint.successfulFetches).toBe(2);
  });

  it('fetches every URL in a bounded public job sitemap and treats a missing role as a complete closure-compatible snapshot', async () => {
    const xml = await fixture('sitemap.xml');
    const source = config({ kind: 'job-sitemap', url: 'https://careers.acme.example/jobs.xml' });
    const first = new StructuredCareerSourceConnector({
      source, resolver, now,
      fetcher: routes({
        'https://careers.acme.example/jobs.xml': xml,
        'https://careers.acme.example/jobs/one': jobPage('one'),
        'https://careers.acme.example/jobs/two': jobPage('two'),
      }),
    });
    const initial = await first.fetch();
    expect(initial.checkpoint.activeExternalIds).toEqual(['one', 'two']);

    const secondXml = '<urlset><url><loc>https://careers.acme.example/jobs/two</loc></url></urlset>';
    const second = new StructuredCareerSourceConnector({
      source, resolver, now,
      fetcher: routes({
        'https://careers.acme.example/jobs.xml': secondXml,
        'https://careers.acme.example/jobs/two': jobPage('two'),
      }),
    });
    const closureSnapshot = await second.fetch(initial.checkpoint);
    expect(closureSnapshot).toMatchObject({ outcome: 'changed', complete: true, rawCount: 1 });
    expect(closureSnapshot.checkpoint.activeExternalIds).toEqual(['two']);

    const empty = new StructuredCareerSourceConnector({
      source, resolver, now,
      fetcher: routes({ 'https://careers.acme.example/jobs.xml': '<urlset></urlset>' }),
    });
    const fullyClosed = await empty.fetch(closureSnapshot.checkpoint);
    expect(fullyClosed).toMatchObject({ outcome: 'changed', complete: true, postings: [], rawCount: 0 });
    expect(fullyClosed.checkpoint.activeExternalIds).toEqual([]);
  });

  it('parses only the explicitly admitted stable embedded payload', async () => {
    const html = await fixture('embedded.html');
    const source = config({
      kind: 'embedded-json', url: 'https://careers.acme.example/openings',
      embedded: { scriptId: 'public-jobs', jobsPath: ['page', 'jobs'] },
      allowedApplicationHosts: [{ host: 'careers.acme.example', pathPrefix: '/apply' }],
    });
    const snapshot = await new StructuredCareerSourceConnector({
      source, resolver, fetcher: routes({ 'https://careers.acme.example/openings': html }), now,
    }).fetch();
    expect(snapshot.postings[0]).toMatchObject({
      externalId: 'embedded-7', title: 'Machine Learning Co-op', locations: ['Toronto, ON', 'Remote'],
      hostedUrl: 'https://careers.acme.example/jobs/embedded-7', declaredWorkMode: 'Hybrid', classificationTags: ['CO_OP'],
    });
  });

  it('rejects malformed, missing, ambiguous, and unstable structured shapes', async () => {
    const malformed = await fixture('malformed.html');
    const cases: Array<[string, StructuredSourceConfig, string]> = [
      [malformed, config(), 'malformed JSON-LD'],
      ['<html>No structured data</html>', config(), 'no JobPosting JSON-LD'],
      [jobPage('', 'https://careers.acme.example/jobs/no-id/apply'), config(), 'stable identifier'],
      [`${jobPage('same')}${jobPage('same')}`, config(), 'duplicate posting ID'],
      [`${jobPage('one')}${jobPage('two', 'https://careers.acme.example/jobs/one/apply?utm_source=feed#form')}`, config(), 'ambiguous duplicate destination'],
      ['<script type="application/json" id="public-jobs">{"page":{"jobs":[]}}</script><script type="application/json" id="public-jobs">{"page":{"jobs":[]}}</script>',
        config({ kind: 'embedded-json', embedded: { scriptId: 'public-jobs', jobsPath: ['page', 'jobs'] } }), 'exactly one'],
    ];
    for (const [body, source, message] of cases) {
      await expect(new StructuredCareerSourceConnector({ source, resolver, fetcher: routes({ [source.url]: body }) }).fetch()).rejects.toThrow(message);
    }
  });

  it('enforces sitemap/document/posting caps before accepting an unbounded source', async () => {
    const sitemap = '<urlset><url><loc>https://careers.acme.example/jobs/one</loc></url><url><loc>https://careers.acme.example/jobs/two</loc></url></urlset>';
    const source = config({ kind: 'job-sitemap', url: 'https://careers.acme.example/map.xml', limits: { maxDocuments: 1 } });
    await expect(new StructuredCareerSourceConnector({ source, resolver, fetcher: routes({ [source.url]: sitemap }) }).fetch())
      .rejects.toThrow('document limit');

    const twoJobs = `${jobPage('one')}${jobPage('two')}`;
    const capped = config({ limits: { maxPostings: 1 } });
    await expect(new StructuredCareerSourceConnector({ source: capped, resolver, fetcher: routes({ [capped.url]: twoJobs }) }).fetch())
      .rejects.toThrow('posting limit');
  });

  it('rejects login/challenge gates, private hosts, source host changes, and application host changes', async () => {
    const gated = config();
    await expect(new StructuredCareerSourceConnector({
      source: gated, resolver, fetcher: routes({ [gated.url]: new Response('Sign in required', { status: 401 }) }),
    }).fetch()).rejects.toThrow('login- or challenge-gated');

    await expect(new StructuredCareerSourceConnector({
      source: gated, resolver: { resolve: async () => ['127.0.0.1'] }, fetcher: routes({ [gated.url]: jobPage('one') }),
    }).fetch()).rejects.toThrow('non-public');

    const redirect = routes({
      [gated.url]: new Response('', { status: 302, headers: { location: 'https://jobs.acme.example/jobs' } }),
      'https://jobs.acme.example/jobs': jobPage('one'),
    });
    await expect(new StructuredCareerSourceConnector({ source: gated, resolver, fetcher: redirect }).fetch()).rejects.toThrow('changed its reviewed host');

    const changedApply = jobPage('one', 'https://apply.vendor.example/jobs/one');
    await expect(new StructuredCareerSourceConnector({ source: gated, resolver, fetcher: routes({ [gated.url]: changedApply }) }).fetch())
      .rejects.toThrow('outside reviewed host contracts');

    const admittedVendor = config({ allowedApplicationHosts: [{ host: 'apply.vendor.example', pathPrefix: '/jobs' }] });
    const hostAwareResolver: HostResolver = {
      resolve: async (hostname) => hostname === 'apply.vendor.example' ? ['10.0.0.2'] : ['93.184.216.34'],
    };
    await expect(new StructuredCareerSourceConnector({
      source: admittedVendor, resolver: hostAwareResolver, fetcher: routes({ [admittedVendor.url]: changedApply }),
    }).fetch()).rejects.toThrow('non-public');
  });

  it('rejects duplicate and cross-host sitemap entries without fetching job documents', async () => {
    for (const [xml, message] of [
      ['<urlset><url><loc>https://careers.acme.example/jobs/one</loc></url><url><loc>https://careers.acme.example/jobs/one</loc></url></urlset>', 'duplicate URLs'],
      ['<urlset><url><loc>https://evil.example/jobs/one</loc></url></urlset>', 'changed its reviewed host'],
      ['<sitemapindex><sitemap><loc>https://careers.acme.example/nested.xml</loc></sitemap></sitemapindex>', 'Only bounded URL-set'],
    ] as const) {
      const source = config({ kind: 'job-sitemap', url: 'https://careers.acme.example/map.xml' });
      await expect(new StructuredCareerSourceConnector({ source, resolver, fetcher: routes({ [source.url]: xml }) }).fetch()).rejects.toThrow(message);
    }
  });
});
