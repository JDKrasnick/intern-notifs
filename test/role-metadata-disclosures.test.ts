import { describe, expect, it } from 'vitest';
import { applicationMetadataArtifactsFromJsonDocuments, extractVerifiedPageMetadataEvidence, projectRoleMetadata } from '../src/role-metadata.js';
import type { Internship } from '../src/types.js';

// Minimal disclosure clauses observed in the 2026-09-05 public-catalog audit.
// The synthetic posting envelope keeps employer content out of unrelated tests.
const fixtures = [
  { employer: 'Booz Allen / Workday', text: 'The projected compensation range for this position is $61,900.00 to $141,000.00 (annualized USD).', min: 61900, max: 141000, period: 'annual' },
  { employer: 'Philips / Workday', text: 'The hourly pay range for this position is $26.00 to $29.00.', min: 26, max: 29, period: 'hourly' },
  { employer: 'ByteDance / custom', text: 'The hourly rate range for this position in the selected city is $45- $45.', min: 45, max: 45, period: 'hourly' },
  { employer: 'Verkada / Greenhouse', text: 'Estimated Hourly Pay Range $55 - $65 USD', min: 55, max: 65, period: 'hourly' },
  { employer: 'Point72 / Greenhouse', text: 'The annual base salary range is $120000.00-$180000.00 (USD).', min: 120000, max: 180000, period: 'annual' },
  { employer: 'SpaceX / Greenhouse', text: 'Base salary: $100,000.00 - $115,000.00/per year', min: 100000, max: 115000, period: 'annual' },
  { employer: 'Zipline / Greenhouse', text: 'The hourly rate for this internship is $54 per hour.', min: 54, max: 54, period: 'hourly' },
  { employer: 'StepStone / Greenhouse', text: 'Salary: $30 / hour', min: 30, max: 30, period: 'hourly' },
  { employer: 'Citadel Securities / custom', text: 'The base salary range for this role is $4,500 to $5,800 per week.', min: 4500, max: 5800, period: 'weekly' },
  { employer: 'Daktronics / iCIMS', text: 'The typical hiring range for this position is $25.00 to $27.00 per hour based on the location of the candidate.', min: 25, max: 27, period: 'hourly' },
  { employer: 'Tower Research / Greenhouse', text: 'Anticipated New York weekly base salary range $3,500-5,700.', min: 3500, max: 5700, period: 'weekly' },
  { employer: 'Nokia / Oracle', text: 'Salary Range $20.10 – $70.40 USD per hour', min: 20.1, max: 70.4, period: 'hourly' },
  { employer: 'Cotiviti / iCIMS', text: 'The hourly pay range is $32 to $40 per hour.', min: 32, max: 40, period: 'hourly' },
];

function project(text: string, location = 'New York, NY, United States') {
  const title = 'Software Engineering Intern';
  const artifacts = applicationMetadataArtifactsFromJsonDocuments([JSON.stringify({
    '@type': 'JobPosting', identifier: '123', title, description: text,
    jobLocation: { address: { addressLocality: location } },
  })]);
  const evidence = extractVerifiedPageMetadataEvidence({ expectedTitle: title, expectedPostingId: '123',
    page: { title }, jsonLdArtifacts: artifacts, sourceId: 'fixture', sourceUrl: 'https://example.test/jobs/123',
    observedAt: '2026-09-05T18:00:00Z', exactPosting: true });
  const job = { title, compensation: { raw: '' }, sourceReferences: [] } as unknown as Internship;
  return projectRoleMetadata(job, evidence);
}

describe('employer disclosure formats from the coverage audit', () => {
  it.each(fixtures)('captures $employer pay with an explicit period', ({ text, min, max, period }) => {
    const result = project(text);
    expect(result.conflicts).toEqual([]);
    expect(result.job.compensation.ranges).toHaveLength(1);
    expect(result.job.compensation.ranges?.[0]).toMatchObject({ minAmount: min, maxAmount: max, currency: 'USD', period });
  });

  it('retains the seven browser-confirmed disclosures through the full evidence and projection path', () => {
    const browserConfirmed = fixtures.slice(-7);
    for (const fixture of browserConfirmed) {
      const result = project(fixture.text);
      expect(result.job.compensation.ranges).toEqual(expect.arrayContaining([
        expect.objectContaining({ minAmount: fixture.min, maxAmount: fixture.max, currency: 'USD', period: fixture.period }),
      ]));
    }
  });

  it.each([
    'The expected wage range for this position is $22 to $41.',
    'Base Salary Range $38,000 — $38,000 USD',
    'Revenue exceeded $11 billion. Hourly employees may apply.',
    'The role pays $20 per hour and includes mentoring.',
  ])('does not guess missing periods or mistake connecting words for currencies: %s', text => {
    const result = project(text);
    if (text.includes('per hour')) expect(result.job.compensation).toMatchObject({ minHourlyUSD: 20, maxHourlyUSD: 20 });
    else expect(result.job.compensation).toEqual({ raw: '' });
  });

  it('retains non-USD and unknown-currency ranges without inventing USD bounds', () => {
    for (const [text, currency] of [
      ['The hourly pay range is $30 to $36.', 'XXX'],
      ['The hourly pay range is CAD $30 to $36.', 'CAD'],
    ]) {
      const compensation = project(text, 'Toronto, Canada').job.compensation;
      expect(compensation).toMatchObject({ ranges: [{ minAmount: 30, maxAmount: 36, currency, period: 'hourly' }] });
      expect(compensation.minHourlyUSD).toBeUndefined();
      expect(compensation.maxHourlyUSD).toBeUndefined();
    }
  });
});
