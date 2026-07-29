import { describe, expect, it } from 'vitest';
import { probeGreenhouseCandidate } from '../src/sources/greenhouse.js';
import { boardIdentityUrl } from '../src/sources/greenhouse-config.js';
import { greenhouseJobsUrl } from '../src/sources/greenhouse.js';
import { acmeJobsResponse } from './fixtures/greenhouse.js';

function response(body: unknown, url: string, init: { status?: number; etag?: string } = {}): Response {
  const result = new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...(init.etag ? { etag: init.etag } : {}) } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

describe('probeGreenhouseCandidate', () => {
  it('collects only review-safe evidence without registering or scheduling a source', async () => {
    const token = 'acmerobotics';
    const result = await probeGreenhouseCandidate(token, async (input) => {
      const url = String(input);
      if (url === boardIdentityUrl(token)) return response({ name: 'Acme Robotics' }, url);
      if (url === greenhouseJobsUrl(token)) return response(acmeJobsResponse, url, { etag: 'W/"acme-1"' });
      throw new Error(`unexpected URL ${url}`);
    }, '2026-07-27T00:00:00.000Z');

    expect(result).toEqual(expect.objectContaining({
      state: 'ok', boardToken: token, boardName: 'Acme Robotics', rawJobs: 4, prospectJobs: 1,
      candidateEligibleJobs: 1, malformedRows: 0, etagPresent: true,
      initialHostSummary: { 'job-boards.greenhouse.io': 4 },
      eligibleRoleSamples: [{ document: '5001', title: 'Software Engineering Intern, Summer 2027' }],
    }));
  });

  it('rejects an invalid token without requesting a URL', async () => {
    let called = false;
    const result = await probeGreenhouseCandidate('Acme/Robotics', async () => { called = true; return response({}, 'https://example.test'); });
    expect(result).toEqual({ state: 'invalid-token', boardToken: 'Acme/Robotics' });
    expect(called).toBe(false);
  });

  it('rejects an identity response from an unapproved host', async () => {
    const result = await probeGreenhouseCandidate('acmerobotics', async () => response({ name: 'Acme Robotics' }, 'https://boards-api.greenhouse.io.evil.test/v1/boards/acmerobotics'));
    expect(result).toEqual({ state: 'identity-response-host-error', boardToken: 'acmerobotics' });
  });

  it('reports transport outages as inconclusive', async () => {
    const result = await probeGreenhouseCandidate('acmerobotics', async () => { throw new TypeError('fetch failed'); });
    expect(result).toEqual({ state: 'transport-error', boardToken: 'acmerobotics', inconclusive: true });
  });
});
