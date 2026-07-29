import { describe, expect, it } from 'vitest';
import { runGreenhouseLiveContract } from '../src/sources/greenhouse-live.js';
import { boardIdentityUrl } from '../src/sources/greenhouse-config.js';
import { greenhouseJobsUrl } from '../src/sources/greenhouse.js';
import { acmeJobsResponse, acmeSource, technicalInternship } from './fixtures/greenhouse.js';

const identityUrl = boardIdentityUrl(acmeSource.boardToken);
const jobsUrl = greenhouseJobsUrl(acmeSource.boardToken);

function json(body: unknown, init: { status?: number; url?: string; etag?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.etag) headers.etag = init.etag;
  const response = new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

interface RouterOptions {
  boardName?: string;
  jobs?: unknown;
  resolvedApplyUrl?: string;
  identityTransportError?: boolean;
  jobsTransportError?: boolean;
  etagTransportError?: boolean;
}

function router(options: RouterOptions = {}): typeof fetch {
  const jobsBody = options.jobs ?? acmeJobsResponse;
  const resolvedApplyUrl = options.resolvedApplyUrl ?? 'https://job-boards.greenhouse.io/acmerobotics/jobs/5001';
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url === identityUrl) {
      if (options.identityTransportError) throw new TypeError('fetch failed');
      return json({ name: options.boardName ?? 'Acme Robotics' }, { url: identityUrl });
    }
    if (url.startsWith(jobsUrl)) {
      if (options.jobsTransportError) throw new TypeError('fetch failed');
      if (headers['If-None-Match'] && options.etagTransportError) throw new TypeError('fetch failed');
      if (headers['If-None-Match']) return new Response(null, { status: 304 });
      return json(jobsBody, { etag: 'W/"acme-1"', url: jobsUrl });
    }
    return json(null, { status: 200, url: resolvedApplyUrl });
  }) as typeof fetch;
}

describe('runGreenhouseLiveContract', () => {
  it('passes identity, schema, ETag, and link health for a healthy board', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router());
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ identity: 'ok', schema: 'ok', etagNotModified: 'ok', linkHealth: 'ok' });
    expect(result.counts).toEqual({ raw: 4, eligible: 1, withheld: 0 });
  });
  it('fails when the returned board name does not match the reviewed allowlist', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router({ boardName: 'Someone Else' }));
    expect(result.status).toBe('failed');
    expect(result.checks.identity).toBe('failed');
  });
  it('treats a jobs transport outage as inconclusive', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router({ jobsTransportError: true }));
    expect(result.status).toBe('inconclusive');
  });
  it('treats an ETag conditional transport outage as inconclusive', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router({ etagTransportError: true }));
    expect(result).toMatchObject({ status: 'inconclusive', checks: { identity: 'ok', schema: 'ok', etagNotModified: 'inconclusive', linkHealth: 'ok' } });
  });
  it('treats an identity transport outage as inconclusive without probing jobs', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router({ identityTransportError: true }));
    expect(result).toMatchObject({ status: 'inconclusive', checks: { identity: 'failed', schema: 'skipped' } });
  });
  it('fails on an invalid job row shape', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router({ jobs: { jobs: [{ ...technicalInternship, title: 5 }] } }));
    expect(result.status).toBe('failed');
    expect(result.checks.schema).toBe('failed');
  });
  it('withholds an off-allowlist role without failing the board', async () => {
    const jobs = { jobs: [{ ...technicalInternship, absolute_url: 'https://apply.evil.test/5001' }], meta: { total: 1 } };
    const result = await runGreenhouseLiveContract(acmeSource, router({ jobs }));
    expect(result.status).toBe('ok');
    expect(result.counts).toMatchObject({ eligible: 0, withheld: 1 });
    expect(result.roleFailures[0]).toMatchObject({ document: '5001', reason: expect.stringContaining('not a reviewed Greenhouse destination') });
  });
  it('quarantines the board when eligible roles resolve to an unapproved host', async () => {
    const result = await runGreenhouseLiveContract(acmeSource, router({ resolvedApplyUrl: 'https://apply.evil.test/5001' }));
    expect(result.status).toBe('failed');
    expect(result.checks.linkHealth).toBe('failed');
    expect(result.roleFailures[0]?.reason).toContain('not an approved destination host');
  });
});
