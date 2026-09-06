import { describe, expect, it } from 'vitest';
import { applicationMetadataArtifactsFromJsonDocuments, extractVerifiedPageMetadataEvidence, projectRoleMetadata } from '../src/role-metadata.js';
import type { Internship } from '../src/types.js';
import { combineRenderedFrameEvidence } from '../src/rendered-destination-evidence.js';

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
  { employer: 'Cotiviti / iCIMS', text: 'Base compensation ranges from $32.00 to $40.00 per hour.', min: 32, max: 40, period: 'hourly' },
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
  it.each([
    ['Base Salary Range $123,500 - $170,000 USD', 123500, 170000, 'USD', 'unknown'],
    ['Salary JPY 2,000 - 4,000 per hour', 2000, 4000, 'JPY', 'hourly'],
    ['Salary KRW 30,000,000 - 40,000,000 per year', 30000000, 40000000, 'KRW', 'annual'],
    ['Salary CA$140K – CA$175K', 140000, 175000, 'CAD', 'unknown'],
    ['Salary AU$30 – AU$40 per hour', 30, 40, 'AUD', 'hourly'],
  ])('preserves disclosed native amounts without a USD or annual guess: %s', (text, min, max, currency, period) => {
    const result = project(String(text));
    expect(result.job.compensation.ranges).toMatchObject([{ minAmount: min, maxAmount: max, currency, period }]);
    expect(result.job.compensation.minAnnualUSD).toBeUndefined();
    expect(result.job.compensation.minHourlyUSD).toBeUndefined();
  });

  it('keeps rendered geographic salary rows separate without guessing their periods', () => {
    const title = 'Early Careers & Interns Specialist';
    const rows = ['California, New York & Washington States\n$120K – $150K • Offers Equity',
      'All other US States\n$95K – $120K • Offers Equity', 'Canada\nCA$140K – CA$175K • Offers Equity'];
    const rendered = combineRenderedFrameEvidence({ role: title, frames: [{ url: 'https://example.test/jobs/123', title,
      visibleText: `${title} Compensation ${rows.join(' ')}`, compensationRows: rows,
      jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }] })!;
    const evidence = extractVerifiedPageMetadataEvidence({ expectedTitle: title, expectedPostingId: '123',
      page: { title, text: rendered.contentExcerpt, compensationSections: rendered.compensationSections },
      sourceId: 'fixture', sourceUrl: rendered.url, observedAt: '2026-09-06T06:28:00Z', exactPosting: true });
    const result = projectRoleMetadata({ title, compensation: { raw: '' }, sourceReferences: [] } as unknown as Internship, evidence);
    expect(result.conflicts).toEqual([]);
    expect(result.job.compensation.ranges).toHaveLength(3);
    expect(result.job.compensation.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 120000, maxAmount: 150000, currency: 'XXX', period: 'unknown', applicabilityLabel: 'California, New York & Washington States' }),
      expect.objectContaining({ minAmount: 95000, maxAmount: 120000, currency: 'XXX', period: 'unknown', applicabilityLabel: 'All other US States' }),
      expect.objectContaining({ minAmount: 140000, maxAmount: 175000, currency: 'CAD', period: 'unknown', applicabilityLabel: 'Canada' }),
    ]));
    expect(result.job.compensation.minAnnualUSD).toBeUndefined();
  });

  it.each(['Salary USD $30 - CAD $40 per hour', 'Desired salary: USD $50 per hour', 'Sign-on bonus USD $10000 per year'])('rejects ambiguous or unrelated pay: %s', (text) => {
    expect(project(text).job.compensation.raw).toBe('');
  });
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
