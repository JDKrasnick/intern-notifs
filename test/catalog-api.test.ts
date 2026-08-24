import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryReleaseStore, MemoryUserStore } from '../src/store.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { Internship } from '../src/types.js';

function job(id: string, seconds: number, title = `Software Intern ${id}`): Internship {
  const observed = `2026-08-23T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    jobId: id, company: 'Acme', title, location: 'Remote', season: 'summer-2027', applyUrl: `https://careers.example.test/${id}`,
    normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id, compensation: { raw: '' }, sourceReferences: [], technical: true,
    open: true, firstSeenAt: observed, catalogVisibleAt: observed, lastSeenAt: observed, notification: { smsPending: false, digestPending: false },
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
    const identity = { educationAudience: { levels: ['Undergraduate'], evidence: 'explicit' } };
    await jobs.putInternship({ ...job('swe', 0), internshipIdentity: identity });
    await jobs.putInternship({ ...job('ml', 10, 'Machine Learning Intern'), internshipIdentity: identity });
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
});
