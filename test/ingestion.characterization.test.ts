import { describe, expect, it } from 'vitest';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { processPosting } from '../src/ingestion/processor.js';
import { mapGreenhouseJob, mapGreenhouseSourcedPosting } from '../src/sources/greenhouse.js';
import { mapLeverPosting, mapLeverSourcedPosting } from '../src/sources/lever.js';
import { parseQuantInternshipMarkdown } from '../src/sources/quant.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';

const fetchedAt = '2026-07-29T12:00:00.000Z';
const leverPostingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const leverPosting = {
  id: leverPostingId,
  text: 'Software Engineering Intern, Summer 2027',
  applyUrl: `https://jobs.lever.co/acme/${leverPostingId}/apply`,
  hostedUrl: `https://jobs.lever.co/acme/${leverPostingId}`,
  descriptionPlain: 'Applicants must be a U.S. citizen. Pays $40-$50/hour.',
  createdAt: 1_783_072_000_000,
  categories: { location: 'New York, NY', commitment: 'Internship' },
  workplaceType: 'hybrid',
};
const leverOptions = { id: 'lever-acme', company: 'Acme', site: 'acme' };

describe('legacy ingestion characterization', () => {
  it('preserves the exact Lever listing boundary', () => {
    expect(mapLeverPosting(leverPosting, leverOptions, fetchedAt, 7)).toEqual({
      sourceId: 'lever-acme',
      document: leverPostingId,
      sourceUrl: 'https://api.lever.co/v0/postings/acme?mode=json',
      row: 7,
      company: 'Acme',
      title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY',
      season: 'summer-2027',
      applyUrl: `https://jobs.lever.co/acme/${leverPostingId}/apply`,
      compensation: { raw: '$40-$50/hour', minHourlyUSD: 40, maxHourlyUSD: 50 },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      state: 'open',
      postedAt: '2026-07-03T09:46:40.000Z',
      providerTimestamp: { value: '2026-07-03T09:46:40.000Z', semantics: 'published' },
      workMode: 'hybrid',
      fetchedAt,
    });
  });

  it('preserves the exact Greenhouse listing boundary', () => {
    expect(mapGreenhouseJob(technicalInternship, acmeSource, fetchedAt, 3)).toEqual({
      sourceId: 'greenhouse-acmerobotics',
      document: '5001',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs?content=true',
      row: 3,
      company: 'Acme Robotics',
      title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY (Hybrid)',
      season: 'summer-2027',
      applyUrl: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5001',
      compensation: {
        raw: '$45/hour',
        minHourlyUSD: 45,
        maxHourlyUSD: 45,
      },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      state: 'open',
      postedAt: '2026-07-20T12:00:00.000Z',
      providerTimestamp: { value: '2026-07-20T12:00:00.000Z', semantics: 'updated' },
      workMode: 'hybrid',
      fetchedAt,
    });
  });

  it('preserves the exact general Markdown listing boundary', () => {
    expect(parseInternshipMarkdown(
      '| Company | Position | Location | Posting | Compensation | Date Posted |\n'
      + '| --- | --- | --- | --- | --- | --- |\n'
      + '| Acme &amp; Co | AI Intern 🇺🇸 | Remote | [Apply](https://careers.example.test/ai?utm_source=list) | $42/hr | 2026-07-28 |',
      { sourceId: 'markdown-fixture', document: 'README.md', sourceUrl: 'https://github.test/list', season: 'summer-2027', fetchedAt },
    )).toEqual([{
      sourceId: 'markdown-fixture',
      document: 'README.md',
      sourceUrl: 'https://github.test/list',
      row: 3,
      company: 'Acme &amp; Co',
      employerLabelOrigin: 'explicit',
      title: 'AI Intern 🇺🇸',
      location: 'Remote',
      season: 'summer-2027',
      applyUrl: 'https://careers.example.test/ai?utm_source=list',
      compensation: { raw: '$42/hr', minHourlyUSD: 42, maxHourlyUSD: 42 },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      state: 'open',
      postedAt: '2026-07-28',
      fetchedAt,
    }]);
  });

  it('preserves the exact Quant Markdown listing boundary', () => {
    expect(parseQuantInternshipMarkdown(
      '## Acme Capital\n\n**Locations**: Chicago\n\n|Role|Links|\n|---|---|\n|SWE|[✅ C++](https://careers.example.test/cpp) [✅ Python 🎓](https://careers.example.test/python)|',
      { sourceId: 'quant-fixture', document: 'README.md', sourceUrl: 'https://github.test/quant', season: 'summer-2027', fetchedAt },
    )).toEqual([
      {
        sourceId: 'quant-fixture', document: 'README.md', sourceUrl: 'https://github.test/quant', row: 7,
        company: 'Acme Capital', title: 'Software Engineering Intern — C++', location: 'Chicago',
        season: 'summer-2027', applyUrl: 'https://careers.example.test/cpp', compensation: { raw: '' },
        requirements: { requiresUsCitizenship: false, advancedDegreeRequired: true }, state: 'open', fetchedAt,
      },
      {
        sourceId: 'quant-fixture', document: 'README.md', sourceUrl: 'https://github.test/quant', row: 7,
        company: 'Acme Capital', title: 'Software Engineering Intern — Python 🎓', location: 'Chicago',
        season: 'summer-2027', applyUrl: 'https://careers.example.test/python', compensation: { raw: '' },
        requirements: { requiresUsCitizenship: false, advancedDegreeRequired: true }, state: 'open', fetchedAt,
      },
    ]);
  });
});

describe('neutral boundary parity', () => {
  /** The neutral boundary adds identity and the persisted classification decision. */
  const additions = {
    externalId: expect.any(String) as unknown as string,
    provenance: 'official-ats' as const,
    technical: true,
    providerEvidence: expect.any(Object) as unknown as object,
    internshipIdentity: expect.any(Object) as unknown as object,
    employerEvidence: expect.any(Object) as unknown as object,
    providerIdentity: expect.any(Object) as unknown as object,
    metadataCompleteness: { complete: true, title: 'complete', location: 'complete' } as const,
  };

  it('produces the legacy Lever listing from the connector and shared processor', () => {
    const legacy = mapLeverPosting(leverPosting, leverOptions, fetchedAt, 7)!;
    const processed = processPosting(mapLeverSourcedPosting(leverPosting, leverOptions, fetchedAt, 7)).listing!;
    // Joining absent Lever description fields left trailing whitespace in the
    // legacy raw text; the parsed rate and every other field are identical.
    expect(processed).toEqual({
      ...legacy,
      ...additions,
      externalId: leverPostingId, locations: ['New York, NY'],
    });
  });

  it('produces the legacy Greenhouse listing from the connector and shared processor', () => {
    const legacy = mapGreenhouseJob(technicalInternship, acmeSource, fetchedAt, 3)!;
    const posting = mapGreenhouseSourcedPosting(technicalInternship, acmeSource, fetchedAt, 3)!;
    expect(processPosting(posting).listing).toEqual({ ...legacy, ...additions, externalId: '5001', locations: ['New York, NY (Hybrid)'] });
  });

  it('attaches explicit season and education evidence before reconciliation', () => {
    const posting = mapGreenhouseSourcedPosting(technicalInternship, acmeSource, fetchedAt, 3)!;
    const processed = processPosting({
      ...posting,
      content: [{ kind: 'requirements', format: 'plain', value: "Currently enrolled in a bachelor's or master's program." }],
    }).listing!;
    expect(processed.internshipIdentity).toMatchObject({
      season: { term: 'summer', year: 2027, evidenceStatus: 'explicit' },
      education: { levels: ['masters', 'undergraduate'], evidenceStatus: 'explicit' },
    });
  });

  it('carries a custom Greenhouse query posting ID into shared destination verification', () => {
    const processed = processPosting({
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1', sourceUrl: 'https://github.com/example/jobs',
      fetchedAt, employer: { name: 'Zipline', authority: 'source-row' }, title: 'Software Engineering Intern',
      content: [{ kind: 'description', format: 'plain', value: 'Build flight software.' }], locations: ['California'],
      applyUrl: 'https://www.zipline.com/open-roles?gh_jid=7974897003', sourceState: 'open', lifecycleAuthority: 'source',
    }).listing!;
    expect(processed.providerIdentity).toMatchObject({ provider: 'greenhouse', postingId: '7974897003',
      sourceId: 'community-list', employerScope: 'employer:zipline' });
  });
});
