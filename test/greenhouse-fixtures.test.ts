import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchesExpectedBoardName, reviewedGreenhouseSources, type ReviewedGreenhouseSource } from '../src/sources/greenhouse-config.js';
import { GREENHOUSE_FIXTURE_ROOT } from '../src/sources/greenhouse-manifest.js';
import { GreenhouseBoardAdapter, greenhouseJobsUrl, type GreenhouseJobsResponse } from '../src/sources/greenhouse.js';
import { validateApplicationUrl, ApplicationUrlValidationError } from '../src/core/application-url.js';

/**
 * Per-company deterministic contract. Every reviewed board's own sanitized
 * fixture is driven through the real adapter, so admitting a company without
 * usable test material fails CI instead of silently shipping unproven mapping.
 */
function readFixture<T>(source: ReviewedGreenhouseSource, file: string): T {
  return JSON.parse(readFileSync(`${GREENHOUSE_FIXTURE_ROOT}/${source.boardToken}/${file}`, 'utf8')) as T;
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.etag) headers.etag = init.etag;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function resolvedResponse(url: string): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

const fetchedAt = new Date('2026-07-27T00:00:00.000Z');

describe.each(reviewedGreenhouseSources.map((source) => [source.id, source] as const))('%s fixture contract', (_id, source) => {
  const identity = readFixture<{ name: string }>(source, 'identity.json');
  const board = readFixture<GreenhouseJobsResponse>(source, 'jobs.json');
  const jobs = board.jobs ?? [];
  const adapter = () => new GreenhouseBoardAdapter({
    source,
    fetchImpl: async () => jsonResponse(board, { etag: `W/"${source.boardToken}-1"` }),
    now: () => fetchedAt,
  });

  it('ships an identity fixture matching the reviewed board-name allowlist', () => {
    expect(matchesExpectedBoardName(identity.name, source.expectedBoardNames)).toBe(true);
    expect(matchesExpectedBoardName(source.admittedBoardName, source.expectedBoardNames)).toBe(true);
  });

  it('maps only eligible roles and never takes the company from the response', async () => {
    const result = await adapter().fetch();
    const prospects = jobs.filter((job) => job.internal_job_id === null || job.internal_job_id === undefined).map((job) => String(job.id));

    expect(result.rawRowCount).toBe(jobs.length);
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.listings.length).toBeLessThan(jobs.length);
    expect(result.rejectedApplicationUrls).toBeUndefined();
    for (const listing of result.listings) {
      expect(listing.company).toBe(source.displayName);
      expect(listing.sourceId).toBe(source.id);
      expect(listing.sourceUrl).toBe(greenhouseJobsUrl(source.boardToken));
      expect(source.allowedInitialHosts).toContain(new URL(listing.applyUrl).hostname);
      expect(listing.title).toMatch(/intern|co-?op|apprentice/i);
      expect(prospects).not.toContain(listing.document);
    }
    expect(result.listings.map((listing) => listing.row)).toEqual(result.listings.map((_listing, index) => index + 1));
  });

  it('decodes requirements and compensation from the escaped description', async () => {
    const result = await adapter().fetch();
    expect(result.listings.some((listing) => listing.requirements?.requiresUsCitizenship)).toBe(true);
    expect(result.listings.some((listing) => listing.compensation.maxHourlyUSD === 48)).toBe(true);
    expect(result.listings.every((listing) => !/&lt;|<p>/.test(listing.compensation.raw))).toBe(true);
  });

  it('records an ETag and honors a conditional 304', async () => {
    const first = await adapter().fetch();
    expect(first.checkpoint).toMatchObject({ etag: `W/"${source.boardToken}-1"`, lastRowCount: first.listings.length, successfulFetches: 1 });

    const headers: Array<Record<string, string>> = [];
    const conditional = new GreenhouseBoardAdapter({
      source,
      fetchImpl: async (_url, init) => { headers.push((init?.headers ?? {}) as Record<string, string>); return new Response(null, { status: 304 }); },
      now: () => fetchedAt,
    });
    const repeat = await conditional.fetch(first.checkpoint);
    expect(repeat.notModified).toBe(true);
    expect(repeat.listings).toEqual([]);
    expect(headers[0]?.['If-None-Match']).toBe(first.checkpoint.etag);
  });

  it('fails the whole board on a bad status, malformed JSON, or invalid shape', async () => {
    const failures: Array<[typeof fetch, RegExp]> = [
      [async () => new Response('nope', { status: 502 }), /fetch failed \(502\)/],
      [async () => new Response('{', { status: 200 }), /malformed JSON/],
      [async () => jsonResponse({ jobs: [{ ...jobs[0], title: 42 }] }), /shape was invalid/],
    ];
    for (const [fetchImpl, expected] of failures) {
      await expect(new GreenhouseBoardAdapter({ source, fetchImpl, now: () => fetchedAt }).fetch()).rejects.toThrow(expected);
    }
  });

  it('accepts each eligible link only when it resolves to a reviewed final host', async () => {
    const result = await adapter().fetch();
    const finalHost = source.allowedFinalHosts[0];
    for (const listing of result.listings) {
      const resolved = `https://${finalHost}${new URL(listing.applyUrl).pathname}`;
      await expect(validateApplicationUrl(listing.applyUrl, async () => resolvedResponse(resolved), source)).resolves.toBe(resolved);
      await expect(validateApplicationUrl(listing.applyUrl, async () => resolvedResponse('https://apply.evil.test/1'), source))
        .rejects.toBeInstanceOf(ApplicationUrlValidationError);
    }
  });
});
