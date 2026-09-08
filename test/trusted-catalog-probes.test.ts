import { describe, expect, it, vi } from 'vitest';
import { recheckTrustedCatalogProbes, TRUSTED_CATALOG_PROBES } from '../src/trusted-catalog-probes.js';
import tenstorrent from './fixtures/trusted-catalog/tenstorrent-5221670007.json' with { type: 'json' };
import boozAllen from './fixtures/trusted-catalog/booz-allen-r0248143.json' with { type: 'json' };
import fab2 from './fixtures/trusted-catalog/fab2-0c4dc4f4-01c9-4138-a666-e7234cda7e95.json' with { type: 'json' };

const publicJobs: Array<Record<string, unknown>> = [
  { title: 'Software Engineering Intern (Oct 2026 start)', location: 'Belgrade, Serbia', workMode: 'onsite', compensation: { raw: '' }, employerPublishedAt: '2026-08-26T18:58:59.000Z', employerUpdatedAt: '2026-09-02T21:54:05.000Z' },
  { title: 'University, 2027 Summer Games Data Scientist Intern - Rome, NY', location: 'Rome, NY', season: 'summer-2027', compensation: { raw: '', minAnnualUSD: 61900, maxAnnualUSD: 141000 } },
  { title: 'Fab Software Engineering Intern - Winter', workMode: 'onsite', locations: ['Austin', 'San Francisco Office'], compensation: { raw: '', minAnnualUSD: 114000, maxAnnualUSD: 131000 }, housing: [{ kind: 'stipend' }] },
];
function fetchFor(jobs = publicJobs) { return vi.fn(async (input: string, init?: RequestInit) => {
  void init;
  if (input.includes('/jobs/6c4c30')) return Response.json(jobs[0]);
  if (input.includes('/jobs/684cee')) return Response.json(jobs[1]);
  if (input.includes('/jobs/af611')) return Response.json(jobs[2]);
  if (input.includes('tenstorrentuniversity')) return Response.json(tenstorrent);
  if (input.includes('myworkdayjobs')) return Response.json(boozAllen);
  if (input.includes('api.ashbyhq.com')) return Response.json(fab2);
  throw new Error(`unexpected URL ${input}`);
}); }

describe('trusted catalog regression probes', () => {
  it('compares the fixture-derived official semantics with public jobs without writes', async () => {
    const fetchImpl = fetchFor(); const results = await recheckTrustedCatalogProbes({ fetchImpl: fetchImpl as typeof fetch, apiUrl: 'https://api.example.test' });
    expect(results.map((result) => result.state)).toEqual(['ok', 'ok', 'ok']);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(TRUSTED_CATALOG_PROBES).toHaveLength(3);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('reports public discrepancies explicitly', async () => {
    const jobs = structuredClone(publicJobs); jobs[1] = { ...jobs[1], season: 'summer-2028', compensation: { raw: '' } };
    const result = (await recheckTrustedCatalogProbes({ fetchImpl: fetchFor(jobs) as typeof fetch }))[1]!;
    expect(result).toMatchObject({ state: 'discrepant' });
    expect(result.discrepancies).toEqual(expect.arrayContaining([expect.stringContaining('public.season'), expect.stringContaining('public.compensation.minAnnualUSD')]));
  });
  it('does not mistake blocked or unavailable endpoints for a passing or closed role', async () => {
    const fetchImpl = fetchFor(); fetchImpl.mockImplementationOnce(async () => new Response('', { status: 403 }));
    const [result] = await recheckTrustedCatalogProbes({ fetchImpl: fetchImpl as typeof fetch });
    expect(result).toMatchObject({ state: 'blocked', official: { state: 'blocked', status: 403 } });
  });
});
