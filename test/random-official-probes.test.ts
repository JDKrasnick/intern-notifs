import { describe, expect, it, vi } from 'vitest';
import { runRandomOfficialProbes } from '../src/random-official-probes.js';

const greenhouse = { id: 123, title: 'Platform Engineering Intern', content: '<p>Build systems.</p>', location: { name: 'New York, NY' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123' };
const job = {
  jobId: 'job-1', title: 'Platform Engineering Intern', location: 'New York, NY', locations: ['New York, NY'], applyUrl: greenhouse.absolute_url,
  sourceReferences: [{ sourceId: 'greenhouse-acme', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', applyUrl: greenhouse.absolute_url,
    providerEvidence: { provider: 'greenhouse', tenant: 'acme', postingId: '123' } }],
};
function fetchFor(publicJob: Record<string, unknown> = job) { return vi.fn(async (url: string) => {
  if (url.includes('/jobs?')) return Response.json({ jobs: [publicJob] });
  if (url.includes('boards-api.greenhouse.io')) return Response.json(greenhouse);
  throw new Error(`unexpected ${url}`);
}); }

describe('random official probes', () => {
  it('uses a deterministic seeded selection and records a tamper-evident receipt', async () => {
    const fetchImpl = fetchFor(); const options = { fetchImpl: fetchImpl as typeof fetch, apiUrl: 'https://api.example.test', count: 1, seed: 'audit-1', now: () => new Date('2026-09-08T00:00:00Z') };
    const first = await runRandomOfficialProbes(options); const second = await runRandomOfficialProbes(options);
    expect(first).toMatchObject({ readOnly: true, candidates: 1, selected: 1, results: [{ state: 'ok', jobId: 'job-1', provider: 'greenhouse' }] });
    expect(first.receipt).toBe(second.receipt); expect(first.results[0]?.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect((fetchImpl.mock.calls as unknown as Array<unknown[]>).every((call) => (call[1] as RequestInit | undefined)?.method === 'GET')).toBe(true);
  });
  it('rejects merged roles and reports actual public discrepancies', async () => {
    const merged = { ...job, sourceReferences: [...job.sourceReferences, { ...job.sourceReferences[0] }] };
    const none = await runRandomOfficialProbes({ fetchImpl: fetchFor(merged) as typeof fetch, apiUrl: 'https://api.example.test', count: 1, seed: 'one' });
    expect(none).toMatchObject({ candidates: 0, selected: 0 });
    const mismatched = await runRandomOfficialProbes({ fetchImpl: fetchFor({ ...job, title: 'Wrong title' }) as typeof fetch, apiUrl: 'https://api.example.test', count: 1, seed: 'one' });
    expect(mismatched.results[0]).toMatchObject({ state: 'discrepant', discrepancies: expect.arrayContaining([expect.stringContaining('title:')]) });
  });
  it('does not call an unavailable publisher a passing probe', async () => {
    const fetchImpl = fetchFor(); fetchImpl.mockImplementation(async (url: string) => url.includes('/jobs?') ? Response.json({ jobs: [job] }) : new Response('', { status: 503 }));
    const run = await runRandomOfficialProbes({ fetchImpl: fetchImpl as typeof fetch, apiUrl: 'https://api.example.test', count: 1, seed: 'one' });
    expect(run.results[0]).toMatchObject({ state: 'unavailable' });
  });
  it('accepts a reviewed custom official apply host when its exact occurrence evidence agrees', async () => {
    const customApply = 'https://careers.acme.test/apply/platform-intern';
    const custom = { ...job, applyUrl: customApply, sourceReferences: [{ ...job.sourceReferences[0], applyUrl: customApply }] };
    const run = await runRandomOfficialProbes({ fetchImpl: fetchFor(custom) as typeof fetch, apiUrl: 'https://api.example.test', count: 1, seed: 'custom' });
    expect(run.results[0]).toMatchObject({ state: 'ok' });
  });
  it('never samples a catalog prefix when its explicit traversal cap is reached', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes('/jobs?')
      ? Response.json({ jobs: [job], cursor: 'next' }) : Response.json(greenhouse));
    await expect(runRandomOfficialProbes({ fetchImpl: fetchImpl as typeof fetch, apiUrl: 'https://api.example.test', count: 1, maxPages: 1 }))
      .rejects.toThrow('no biased prefix was sampled');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
