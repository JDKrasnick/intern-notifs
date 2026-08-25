import { describe, expect, it } from 'vitest';
import { catalogEducation, catalogGroupDetails, filterCatalogGroupDetails, filterCatalogGroups, groupCatalogJobs } from '../src/catalog-groups.js';
import type { EducationEvidenceStatus, Internship, InternshipIdentity, InternshipProgramType, SeasonEvidenceStatus } from '../src/types.js';

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

function identity(options: {
  educationEvidence?: EducationEvidenceStatus;
  programType?: InternshipProgramType;
  seasonEvidence?: SeasonEvidenceStatus;
} = {}): InternshipIdentity {
  const provenance = [{ source: 'deterministic-inference' as const, sourceId: 'test', evidenceCode: 'test' }];
  return {
    company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
    programType: { value: options.programType ?? 'internship', provenance },
    season: { term: 'summer', year: 2027, evidenceStatus: options.seasonEvidence ?? 'explicit', provenance },
    education: { levels: ['undergraduate'], evidenceStatus: options.educationEvidence ?? 'explicit', provenance },
    title: {
      official: { value: 'Software Engineer Intern', provenance },
      display: { value: 'Software Engineer Intern', provenance },
      search: { value: 'software engineer intern', provenance },
    },
    disciplines: [], locations: [],
  };
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

  it('treats source decoration and corporate suffixes as the same employer without changing the display name', () => {
    const groups = groupCatalogJobs([
      job('one', 0, { company: 'TikTok' }),
      job('two', 2, { company: '🔥 TikTok' }),
      job('three', 4, { company: 'TikTok, Inc.' }),
      job('four', 8, { company: 'TIKTOK' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.row).toMatchObject({ kind: 'employer-release', company: 'TikTok', roleCount: 4 });
  });

  it('groups only compatible program dimensions and leaves conflicting education individual', () => {
    const undergraduate = identity();
    const groups = groupCatalogJobs([
      job('one', 0, { internshipIdentity: undergraduate }),
      job('two', 10, { internshipIdentity: undergraduate }),
      job('conflict', 20, { internshipIdentity: identity({ educationEvidence: 'conflicting' }) }),
    ]);
    expect(groups.map(({ row }) => [row.kind, row.roleCount])).toEqual([['individual', 1], ['program-group', 2]]);
    expect(catalogEducation(groups[0]!.jobs[0]!)).toMatchObject({ evidence: 'conflicting' });
  });

  it('matches unspecified education and recomputes every visible summary from filtered roles', () => {
    const groups = groupCatalogJobs([
      job('ml', 0, { title: 'Machine Learning Intern', location: 'Boston' }),
      job('product', 10, { title: 'Product Manager Intern', location: 'Austin' }),
    ]);
    expect(groups.map(({ row }) => row.kind)).toEqual(['individual', 'individual']);
    const filtered = filterCatalogGroups(groups, { disciplines: ['AI/ML'], educationLevels: ['Doctoral'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.row).toMatchObject({ roleCount: 1, titles: ['Machine Learning Intern'], locations: ['Boston'] });
    expect(filtered[0]!.row.disciplines).toContain('AI/ML');
  });

  it('recomputes materialized timestamps, newness, and normalized locations after filtering', () => {
    const jobs = [
      job('ml', 0, { title: 'Machine Learning Intern', location: 'Boston | Remote' }),
      job('two', 2), job('three', 4), job('four', 8),
    ];
    const details = catalogGroupDetails(groupCatalogJobs(jobs)[0]!);
    const filtered = filterCatalogGroupDetails([details], { disciplines: ['AI/ML'] });
    expect(filtered[0]?.group).toMatchObject({
      roleCount: 1,
      featuredRole: { jobId: 'ml' },
      locations: ['Boston', 'Remote'],
      createdAt: '2026-08-23T12:00:00.000Z',
      updatedAt: '2026-08-23T12:00:00.000Z',
      hasNewRoles: false,
    });
  });

  it('keeps structured-location filtering identical before and after materialization', () => {
    const structured = identity();
    structured.locations = [{ name: 'Boston', workMode: 'onsite', provenance: [] }];
    const groups = groupCatalogJobs([job('boston', 0, { location: 'Multiple locations', internshipIdentity: structured })]);
    expect(filterCatalogGroups(groups, { locations: ['Boston'] })).toHaveLength(1);
    expect(filterCatalogGroupDetails(groups.map(catalogGroupDetails), { locations: ['Boston'] })).toHaveLength(1);
  });

  it('preserves full role titles and both detail and official application actions', () => {
    const programIdentity = identity();
    const group = groupCatalogJobs([
      job('one', 0, { internshipIdentity: programIdentity, compensation: { raw: '$42/hr' } }),
      job('two', 10, { internshipIdentity: programIdentity, compensation: { raw: '$48/hr' } }),
    ])[0]!;
    const details = catalogGroupDetails(group);
    expect(details.roles[0]).toMatchObject({ title: expect.stringContaining('Software Engineer Intern'), detailUrl: expect.stringContaining('/jobs/'), officialApplyUrl: expect.stringContaining('careers.example.test') });
    expect(details.group).toMatchObject({
      compensations: ['$48/hr', '$42/hr'],
      featuredRole: { jobId: 'two', compensation: { raw: '$48/hr' }, firstSeenAt: '2026-08-23T12:00:10.000Z' },
    });
  });

  it('keeps a program row identifier stable when a compatible role arrives later', () => {
    const programIdentity = identity();
    const first = groupCatalogJobs([job('one', 0, { internshipIdentity: programIdentity })])[0]!.row.groupId;
    const original = [job('one', 0, { internshipIdentity: programIdentity }), job('two', 10, { internshipIdentity: programIdentity })];
    expect(first).toBe(groupCatalogJobs(original)[0]!.row.groupId);
    expect(groupCatalogJobs(original)[0]!.row.groupId).toBe(groupCatalogJobs([...original, job('three', 20, { internshipIdentity: programIdentity })])[0]!.row.groupId);
  });

  it('does not combine different program types or evidence-poor seasons', () => {
    const groups = groupCatalogJobs([
      job('internship', 0, { internshipIdentity: identity() }),
      job('new-grad', 10, { internshipIdentity: identity({ programType: 'new-grad' }) }),
      job('inferred-season', 20, { internshipIdentity: identity({ seasonEvidence: 'inferred' }) }),
    ]);
    expect(groups.map(({ row }) => row.kind)).toEqual(['individual', 'individual', 'individual']);
  });
});
