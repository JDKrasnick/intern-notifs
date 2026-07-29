import { describe, expect, it } from 'vitest';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { mapGreenhouseJob } from '../src/sources/greenhouse.js';
import { mapLeverPosting } from '../src/sources/lever.js';
import { parseQuantInternshipMarkdown } from '../src/sources/quant.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';

const fetchedAt = '2026-07-29T12:00:00.000Z';

describe('legacy ingestion characterization', () => {
  it('preserves the exact Lever listing boundary', () => {
    expect(mapLeverPosting({
      id: 'lever-role-1',
      text: 'Software Engineering Intern, Summer 2027',
      applyUrl: 'https://jobs.lever.co/acme/lever-role-1/apply',
      hostedUrl: 'https://jobs.lever.co/acme/lever-role-1',
      descriptionPlain: 'Applicants must be a U.S. citizen. Pays $40-$50/hour.',
      createdAt: 1_783_072_000_000,
      categories: { location: 'New York, NY', commitment: 'Internship' },
      workplaceType: 'hybrid',
    }, { id: 'lever-acme', company: 'Acme', site: 'acme' }, fetchedAt, 7)).toEqual({
      sourceId: 'lever-acme',
      document: 'lever-role-1',
      sourceUrl: 'https://api.lever.co/v0/postings/acme?mode=json',
      row: 7,
      company: 'Acme',
      title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY',
      season: 'summer-2027',
      applyUrl: 'https://jobs.lever.co/acme/lever-role-1/apply',
      compensation: { raw: 'Applicants must be a U.S. citizen. Pays $40-$50/hour.   ', maxHourlyUSD: 50 },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      state: 'open',
      postedAt: '2026-07-03T09:46:40.000Z',
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
        raw: 'Join our platform team. Applicants must be a U.S. citizen. Pays $45/hour.',
        maxHourlyUSD: 45,
      },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      state: 'open',
      postedAt: '2026-07-20T12:00:00.000Z',
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
      title: 'AI Intern 🇺🇸',
      location: 'Remote',
      season: 'summer-2027',
      applyUrl: 'https://careers.example.test/ai?utm_source=list',
      compensation: { raw: '$42/hr', maxHourlyUSD: 42 },
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
