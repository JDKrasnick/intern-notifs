import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryReleaseStore, MemoryUserStore } from '../src/store.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { Internship, InternshipIdentity } from '../src/types.js';

function job(id: string, seconds: number, title = `Software Intern ${id}`): Internship {
  const observed = `2026-08-23T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    jobId: id, company: 'Acme', title, location: 'Remote', season: 'summer-2027', applyUrl: `https://careers.example.test/${id}`,
    normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id, compensation: { raw: '' }, sourceReferences: [], technical: true,
    open: true, firstSeenAt: observed, catalogVisibleAt: observed, lastSeenAt: observed, notification: { smsPending: false, digestPending: false },
  };
}

function identity(title: string, discipline: 'software' | 'ai-ml'): InternshipIdentity {
  const provenance = [{ source: 'deterministic-inference' as const, sourceId: 'test', evidenceCode: 'test' }];
  return {
    company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
    programType: { value: 'internship', provenance },
    season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance },
    education: { levels: ['undergraduate'], evidenceStatus: 'explicit', provenance },
    title: {
      official: { value: title, provenance }, display: { value: title, provenance },
      search: { value: title.toLowerCase(), provenance },
    },
    disciplines: [{ value: discipline, provenance }], locations: [],
  };
}

const event = (method: string, path: string, queryStringParameters?: Record<string, string>, userId?: string) => ({
  rawPath: path, queryStringParameters,
  requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
});
const body = <T>(response: { body: string }) => JSON.parse(response.body) as T;

describe('grouped catalog API', () => {
  it('lists public rows, recomputes filtered summaries, and opens complete group details', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('swe', 0), internshipIdentity: identity('Software Intern swe', 'software') });
    await jobs.putInternship({ ...job('ml', 10, 'Machine Learning Intern'), internshipIdentity: identity('Machine Learning Intern', 'ai-ml') });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const listing = await handler(event('GET', '/catalog', { discipline: 'AI/ML' }));
    const groups = body<{ groups: Array<{ groupId: string; roleCount: number; titles: string[] }> }>(listing).groups;
    expect(groups).toMatchObject([{ roleCount: 1, titles: ['Machine Learning Intern'] }]);

    const unfiltered = body<{ groups: Array<{ groupId: string }> }>(await handler(event('GET', '/catalog'))).groups;
    const details = await handler(event('GET', `/catalog/groups/${unfiltered[0]!.groupId}`));
    expect(body<{ roles: unknown[] }>(details).roles).toHaveLength(2);
  });

  it('returns only the signed-in user release and handles an unavailable store as not found', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship({ ...job('one', 0), open: false });
    const releases = new MemoryReleaseStore();
    await releases.putRelease({ releaseId: 'release-1', userId: 'student-a', jobIds: ['one'], newJobIds: ['one'], createdAt: '2026-08-23T12:00:08.000Z' });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore(), releases });
    expect((await handler(event('GET', '/me/releases/release-1'))).statusCode).toBe(401);
    expect((await handler(event('GET', '/me/releases/release-1', undefined, 'student-b'))).statusCode).toBe(404);
    const response = await handler(event('GET', '/me/releases/release-1', undefined, 'student-a'));
    expect(body<{ deepLink: string; groups: Array<{ roles: unknown[] }> }>(response)).toMatchObject({ deepLink: 'internnotifs://releases/release-1', groups: [{ roles: [expect.any(Object)] }] });
    expect((await createApiHandler({ jobs, users: new MemoryUserStore() })(event('GET', '/me/releases/release-1', undefined, 'student-a'))).statusCode).toBe(404);
  });

  it('serves a materialized page without rebuilding the complete catalog', async () => {
    const jobs = new MemoryInternshipStore();
    const role = job('one', 0);
    await jobs.putInternship(role);
    await jobs.putCatalogProjection(groupCatalogJobs([role]).map(catalogGroupDetails), '2026-08-24T00:00:00.000Z');
    jobs.listCatalog = async () => { throw new Error('projection should avoid a catalog rebuild'); };
    const response = await createApiHandler({ jobs, users: new MemoryUserStore() })(event('GET', '/catalog', { limit: '1' }));
    expect(response.statusCode).toBe(200);
    expect(body<{ groups: Array<{ roleCount: number }> }>(response)).toMatchObject({ groups: [{ roleCount: 1 }] });
  });

  it('preserves availability, employer, and explicit-requirement browse filters', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('open', 0), employerCategory: 'normal' });
    await jobs.putInternship({
      ...job('restricted', 10), employerCategory: 'startup',
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true },
    });
    await jobs.putInternship({ ...job('closed', 20), open: false, employerCategory: 'startup' });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const filtered = body<{ groups: Array<{ roleIds: string[] }> }>(await handler(event('GET', '/catalog', {
      employerCategory: 'startup', hideUsCitizenshipRequired: 'true', hideAdvancedDegreeRequired: 'true',
    }))).groups;
    expect(filtered).toEqual([]);
    const closed = body<{ groups: Array<{ roleIds: string[] }> }>(await handler(event('GET', '/catalog', {
      status: 'closed', employerCategory: 'startup',
    }))).groups;
    expect(closed).toMatchObject([{ roleIds: ['closed'] }]);

    await jobs.putCatalogProjection(
      groupCatalogJobs(await jobs.listCatalog(), { includeClosed: true }).map(catalogGroupDetails),
      new Date().toISOString(),
    );
    jobs.listCatalog = async () => { throw new Error('closed filtering should use the projection'); };
    const projectedClosed = body<{ groups: Array<{ roleIds: string[] }> }>(await handler(event('GET', '/catalog', {
      status: 'closed', employerCategory: 'startup',
    }))).groups;
    expect(projectedClosed).toMatchObject([{ roleIds: ['closed'] }]);
  });

  it('applies the active filters when a grouped row is opened', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('open', 0), internshipIdentity: identity('Software Intern', 'software') });
    await jobs.putInternship({ ...job('closed', 10), open: false, internshipIdentity: identity('Software Intern', 'software') });
    await jobs.putCatalogProjection(
      groupCatalogJobs(await jobs.listCatalog(), { includeClosed: true }).map(catalogGroupDetails),
      new Date().toISOString(),
    );
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const row = body<{ groups: Array<{ groupId: string; roleIds: string[] }> }>(await handler(event('GET', '/catalog', { status: 'closed' }))).groups[0]!;
    expect(row.roleIds).toEqual(['closed']);
    const details = body<{ group: { roleCount: number }; roles: Array<{ jobId: string; open: boolean }> }>(
      await handler(event('GET', `/catalog/groups/${row.groupId}`, { status: 'closed' })),
    );
    expect(details).toMatchObject({ group: { roleCount: 1 }, roles: [{ jobId: 'closed', open: false }] });
  });
});
