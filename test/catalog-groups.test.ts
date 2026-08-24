import { describe, expect, it } from 'vitest';
import { catalogEducation, catalogGroupDetails, filterCatalogGroups, groupCatalogJobs } from '../src/catalog-groups.js';
import type { Internship } from '../src/types.js';

type IdentityJob = Internship & { internshipIdentity?: Record<string, unknown> };

function job(id: string, seconds: number, overrides: Record<string, unknown> = {}): IdentityJob {
  const observed = `2026-08-23T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    jobId: id, company: 'Acme', title: `Software Engineer Intern ${id}`, location: 'New York | Remote', season: 'summer-2027',
    applyUrl: `https://careers.example.test/${id}`, normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id,
    compensation: { raw: '' }, sourceReferences: [], technical: true, open: true, firstSeenAt: observed, catalogVisibleAt: observed,
    lastSeenAt: observed, notification: { smsPending: false, digestPending: false }, ...overrides,
  } as IdentityJob;
}

describe('grouped catalog domain', () => {
  it('uses an eight-second employer burst and does not absorb a later unrelated program', () => {
    const jobs = [job('one', 0), job('two', 2), job('three', 4), job('four', 8), job('later', 20, { season: 'fall-2027' })];
    const groups = groupCatalogJobs(jobs);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.row).toMatchObject({ kind: 'individual', roleCount: 1, seasons: ['fall-2027'] });
    expect(groups[1]?.row).toMatchObject({ kind: 'employer-release', roleCount: 4, titles: expect.any(Array) });
    expect(groups[1]?.row.titles).toHaveLength(3);
  });

  it('groups only compatible program dimensions and leaves conflicting education individual', () => {
    const undergraduate = { educationAudience: { levels: ['Undergraduate'], evidence: 'explicit' } };
    const groups = groupCatalogJobs([
      job('one', 0, { internshipIdentity: undergraduate }),
      job('two', 10, { internshipIdentity: undergraduate }),
      job('conflict', 20, { internshipIdentity: { educationAudience: { levels: ['Undergraduate'], evidence: 'conflicting' } } }),
    ]);
    expect(groups.map(({ row }) => [row.kind, row.roleCount])).toEqual([['individual', 1], ['program-group', 2]]);
    expect(catalogEducation(groups[0]!.jobs[0]!)).toMatchObject({ evidence: 'conflicting' });
  });

  it('matches unspecified education and recomputes every visible summary from filtered roles', () => {
    const groups = groupCatalogJobs([
      job('ml', 0, { title: 'Machine Learning Intern', location: 'Boston' }),
      job('product', 10, { title: 'Product Manager Intern', location: 'Austin' }),
    ]);
    const filtered = filterCatalogGroups(groups, { disciplines: ['AI/ML'], educationLevels: ['Doctoral'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.row).toMatchObject({ roleCount: 1, titles: ['Machine Learning Intern'], locations: ['Boston'] });
    expect(filtered[0]!.row.disciplines).toContain('AI/ML');
  });

  it('preserves full role titles and both detail and official application actions', () => {
    const group = groupCatalogJobs([job('one', 0), job('two', 10)])[0]!;
    const details = catalogGroupDetails(group);
    expect(details.roles[0]).toMatchObject({ title: expect.stringContaining('Software Engineer Intern'), detailUrl: expect.stringContaining('/jobs/'), officialApplyUrl: expect.stringContaining('careers.example.test') });
  });

  it('keeps a program row identifier stable when a compatible role arrives later', () => {
    const original = [job('one', 0), job('two', 10)];
    expect(groupCatalogJobs(original)[0]!.row.groupId).toBe(groupCatalogJobs([...original, job('three', 20)])[0]!.row.groupId);
  });
});
