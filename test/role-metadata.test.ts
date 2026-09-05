import { describe, expect, it } from 'vitest';
import {
  applicationMetadataArtifactsFromJsonDocuments,
  compensationFromRanges,
  extractCompensationRanges,
  extractPostingMetadataEvidence,
  extractRoleMetadataEvidence,
  extractVerifiedPageMetadataEvidence,
  projectRoleMetadata,
  reconcileRoleMetadata,
} from '../src/role-metadata.js';
import type { FieldProvenance, Internship, RoleMetadataEvidence } from '../src/types.js';

const observedAt = '2026-09-04T12:00:00.000Z';
const field: FieldProvenance = {
  source: 'official-page', sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123',
  evidenceCode: 'compensation-range', contentHash: 'artifact', observedAt,
};

function evidence(overrides: Partial<RoleMetadataEvidence>): RoleMetadataEvidence {
  return {
    schemaVersion: 1, extractionVersion: 2, artifactHash: 'artifact', sourceClass: 'official-page',
    sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123', observedAt, exactPosting: true,
    ...overrides,
  };
}

function job(overrides: Partial<Internship> = {}): Internship {
  return {
    jobId: 'job-1', company: 'Acme', title: 'PhD Machine Learning Intern — Remote', location: 'Location not specified',
    season: 'summer-2027', applyUrl: 'https://careers.acme.test/jobs/123', normalizedUrl: 'https://careers.acme.test/jobs/123',
    fingerprint: 'fingerprint', compensation: { raw: '' }, sourceReferences: [], open: true,
    firstSeenAt: observedAt, lastSeenAt: observedAt, notification: { smsPending: false, digestPending: false }, ...overrides,
  };
}

describe('provider-neutral role metadata', () => {
  it.each([
    ['999', false], ['123', true], [undefined, true],
  ])('checks singleton JSON-LD identifier %s before projecting pay', (identifier, accepted) => {
    const original = job({ title: 'Software Engineering Intern' });
    const extracted = extractVerifiedPageMetadataEvidence({
      expectedTitle: original.title, expectedPostingId: '123', page: { title: original.title },
      jsonLdArtifacts: [{ title: original.title, identifier, compensationText: 'USD $99/hour' }],
      sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    expect(projectRoleMetadata(original, extracted).job.compensation.maxHourlyUSD).toBe(accepted ? 99 : undefined);
  });

  it.each([
    ['New York, NY', 'USD', 50], ['Toronto, ON', 'XXX', undefined],
  ])('uses the explicit page location %s to interpret dollar pay', (location, currency, maximum) => {
    const original = job({ title: 'Software Engineering Intern' });
    const extracted = extractVerifiedPageMetadataEvidence({
      expectedTitle: original.title, page: { title: original.title,
        text: `Location: ${location}. The pay range is $40-$50/hour.` },
      sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    expect(extracted[0]?.compensationRanges?.[0]?.currency).toBe(currency);
    const projected = projectRoleMetadata(original, extracted).job;
    expect(projected.locations).toEqual([location]);
    expect(projected.compensation.maxHourlyUSD).toBe(maximum);
  });

  it('preserves accepted scalars through conflict, resolution, and withdrawal', () => {
    const original = job({ title: 'Software Engineering Intern' });
    const facts = (sourceId: string, changed: boolean) => extractPostingMetadataEvidence({
      artifact: { title: original.title, workMode: changed ? 'hybrid' : 'remote',
        deadline: changed ? '2026-11-01' : '2026-10-01',
        publishedAt: changed ? '2026-08-02' : '2026-08-01',
        updatedAt: changed ? '2026-09-02' : '2026-09-01' },
      sourceClass: 'official-page', sourceId, sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    const first = facts('one', false); const second = facts('two', true);
    const accepted = projectRoleMetadata(original, first).job;
    const conflicted = projectRoleMetadata(accepted, [...first, ...second]);
    expect(conflicted.conflicts).toHaveLength(4);
    for (const key of ['workMode', 'applicationDeadline', 'employerPublishedAt', 'employerUpdatedAt'] as const) {
      expect(conflicted.job[key]).toEqual(accepted[key]);
      expect(conflicted.job.roleMetadata?.[key]).toEqual(accepted.roleMetadata?.[key]);
    }
    expect(projectRoleMetadata(conflicted.job, [...second, ...first]).job).toEqual(conflicted.job);
    const resolved = projectRoleMetadata(conflicted.job, second);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.job).toMatchObject({ workMode: 'hybrid', applicationDeadline: { date: '2026-11-01' },
      employerPublishedAt: '2026-08-02T00:00:00.000Z', employerUpdatedAt: '2026-09-02T00:00:00.000Z' });
    for (const prior of [conflicted.job, resolved.job]) {
      const withdrawn = projectRoleMetadata(prior, []).job;
      for (const key of ['workMode', 'applicationDeadline', 'employerPublishedAt', 'employerUpdatedAt', 'roleMetadata'] as const) {
        expect(withdrawn[key]).toBeUndefined();
      }
      expect(withdrawn.notification).toEqual(original.notification);
    }
  });

  it('keeps differently applicable USD ranges separate without global extrema', () => {
    const ranges = extractCompensationRanges(
      'San Francisco, CA: $45-$55/hour; New York, NY: $50-$60/hour',
      { provenance: field, knownLocations: ['San Francisco, CA', 'New York, NY'] },
    );
    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => range.applicableLocations)).toEqual([['New York, NY'], ['San Francisco, CA']]);
    const compensation = compensationFromRanges(ranges);
    expect(compensation.ranges).toHaveLength(2);
    expect(compensation.minHourlyUSD).toBeUndefined();
    expect(compensation.maxHourlyUSD).toBeUndefined();
  });

  it('projects legacy bounds only from one unambiguous global USD range', () => {
    const ranges = extractCompensationRanges('The base pay range is USD $90,000-$120,000 per year.', { provenance: field });
    expect(compensationFromRanges(ranges)).toMatchObject({ minAnnualUSD: 90_000, maxAnnualUSD: 120_000 });
  });

  it('does not mistake compensation headings for location applicability', () => {
    const hourly = extractCompensationRanges('The pay range is: $40-$50/hour.', {
      provenance: field, knownLocations: ['New York, NY'],
    });
    const annual = extractCompensationRanges('Base salary: $100,000-$120,000/year.', {
      provenance: field, knownLocations: ['New York, NY'],
    });
    const locationSpecific = extractCompensationRanges('New York, NY: $45-$55/hour.', {
      provenance: field, knownLocations: ['New York, NY'],
    });
    expect(compensationFromRanges(hourly)).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 50 });
    expect(compensationFromRanges(annual)).toMatchObject({ minAnnualUSD: 100_000, maxAnnualUSD: 120_000 });
    expect(locationSpecific).toMatchObject([{ applicableLocations: ['New York, NY'] }]);
    expect(compensationFromRanges(locationSpecific).minHourlyUSD).toBeUndefined();
  });

  it('keeps a repeated-period pay expression as one range', () => {
    expect(extractCompensationRanges('The market range is USD $40/hour - $85/hour.', { provenance: field }))
      .toMatchObject([{ minAmount: 40, maxAmount: 85, currency: 'USD', period: 'hourly' }]);
  });

  it('binds graduation dates to the graduation clause and does not treat pursuing a degree as a completed minimum', () => {
    const [item] = extractPostingMetadataEvidence({
      artifact: { title: 'Engineering Intern', text: 'Applications close 11 Nov 2026. Required Qualifications: Working toward a bachelor’s or master’s degree with an anticipated graduation date of Winter 2027, Spring 2028, Winter 2028, or Spring 2029.' },
      sourceClass: 'official-page', sourceId: 'workday-acme', sourceUrl: 'https://example.test/jobs/123', observedAt, exactPosting: true,
    });
    expect(item?.education).toMatchObject({ graduationDateWindow: { start: '2027-01', end: '2029-05' } });
    expect(item?.education?.minimumDegree).toBeUndefined();
    expect(item?.applicationDeadline?.value).toEqual({ kind: 'date', date: '2026-11-11' });
  });

  it('retains unsupported currency as evidence without projecting it publicly', () => {
    const [item] = extractPostingMetadataEvidence({
      artifact: { title: 'Software Intern', compensationText: 'CAD $30-$40/hour' }, sourceClass: 'official-ats',
      sourceId: 'lever-acme', sourceUrl: 'https://api.lever.test/acme', observedAt, exactPosting: true,
    });
    expect(item?.compensationRanges?.[0]?.currency).toBe('CAD');
    expect(reconcileRoleMetadata(item ? [item] : []).compensation).toBeUndefined();
  });

  it('does not assume an ambiguous dollar symbol is USD without a US location', () => {
    const ranges = extractCompensationRanges('The pay range is $30-$40/hour.', { provenance: field, knownLocations: ['Toronto, ON'] });
    expect(ranges[0]?.currency).toBe('XXX');
    expect(compensationFromRanges(ranges)).toEqual({ raw: '' });
  });

  it('retains unsupported pay periods as evidence without projecting them publicly', () => {
    const [item] = extractPostingMetadataEvidence({
      artifact: { title: 'Software Intern', compensationText: 'USD $500-$700/week' }, sourceClass: 'official-ats',
      sourceId: 'lever-acme', sourceUrl: 'https://api.lever.test/acme', observedAt, exactPosting: true,
    });
    expect(item?.compensationRanges?.[0]?.period).toBe('weekly');
    expect(reconcileRoleMetadata(item ? [item] : []).compensation).toBeUndefined();
  });

  it('accepts explicit degree and work-mode title evidence but never an inexact artifact', () => {
    const inferred = extractRoleMetadataEvidence({
      artifact: { title: 'PhD Research Intern — Remote' }, sourceClass: 'deterministic-inference',
      sourceId: 'community-acme', sourceUrl: 'https://example.test/source', observedAt, exactPosting: true, titleOnly: true,
    });
    expect(inferred).toMatchObject({ education: { levels: ['doctoral'], evidenceStatus: 'explicit' }, workMode: { value: 'remote' } });
    expect(extractRoleMetadataEvidence({
      artifact: { title: 'PhD Research Intern — Remote', text: 'Join our research team.' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: 'https://example.test/jobs/123', observedAt, exactPosting: true,
    })).toBeUndefined();
    expect(extractRoleMetadataEvidence({
      artifact: { title: 'PhD Research Intern — Remote' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: 'https://example.test/aggregate', observedAt, exactPosting: false,
    })).toBeUndefined();
  });

  it('matches role-specific JSON-LD by immutable posting ID and rejects an aggregate mismatch', () => {
    const artifacts = applicationMetadataArtifactsFromJsonDocuments([JSON.stringify({ '@graph': [
      { '@type': 'JobPosting', identifier: { value: '123' }, title: 'Software Engineering Intern',
        description: 'Candidates pursuing a Bachelor degree. Pay is $40-$50/hour.', validThrough: '2026-10-01T23:59:00-04:00',
        jobLocationType: 'TELECOMMUTE', baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { minValue: 40, maxValue: 50, unitText: 'HOUR' } } },
      { '@type': 'JobPosting', identifier: { value: '456' }, title: 'Data Intern', description: 'Another role' },
    ] })]);
    const selected = extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '123', page: { title: 'Software Engineering Intern' },
      jsonLdArtifacts: artifacts, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123', observedAt, exactPosting: true,
    });
    expect(selected.some((item) => item.sourceClass === 'official-json-ld' && item.compensationRanges?.[0]?.minAmount === 40)).toBe(true);
    expect(selected.find((item) => item.sourceClass === 'official-json-ld')?.applicationDeadline?.value)
      .toEqual({ kind: 'date', date: '2026-10-01', timezone: 'UTC-04:00' });
    expect(extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '123', page: { title: 'Acme Careers' },
      jsonLdArtifacts: artifacts, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123', observedAt, exactPosting: true,
    }).some((item) => item.sourceClass === 'official-json-ld')).toBe(true);
    expect(extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '999', page: { title: 'Careers at Acme' },
      jsonLdArtifacts: artifacts, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs', observedAt, exactPosting: false,
    })).toEqual([]);

    const prefixCollision = applicationMetadataArtifactsFromJsonDocuments([JSON.stringify({ '@graph': [
      { '@type': 'JobPosting', identifier: { value: '1234' }, title: 'Software Engineering Intern',
        baseSalary: { currency: 'USD', value: { value: 99, unitText: 'HOUR' } } },
      { '@type': 'JobPosting', identifier: { value: '456' }, title: 'Software Engineering Intern' },
    ] })]);
    expect(extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '123', page: { title: 'Careers at Acme' },
      jsonLdArtifacts: prefixCollision, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs', observedAt, exactPosting: true,
    })).toEqual([]);
  });

  it('is deterministic across write order and preserves an existing scalar on an equal-authority conflict', () => {
    const first = evidence({ artifactHash: 'one', workMode: { value: 'remote', provenance: [{ ...field, contentHash: 'one' }] } });
    const second = evidence({ artifactHash: 'two', workMode: { value: 'hybrid', provenance: [{ ...field, contentHash: 'two' }] } });
    const left = reconcileRoleMetadata([first, second], job({ workMode: 'onsite' }));
    const right = reconcileRoleMetadata([second, first], job({ workMode: 'onsite' }));
    expect(left).toEqual(right);
    expect(left.metadata?.workMode).toBeUndefined();
    expect(left.conflicts).toMatchObject([{ field: 'work-mode', evidenceHashes: ['one', 'two'] }]);
  });

  it('projects structured identity program type and normalized metadata without changing durable state', () => {
    const metadata = extractPostingMetadataEvidence({
      artifact: { title: 'BS/MS Software Co-op — Hybrid', text: 'Graduating between May 2027 and June 2028.', locations: ['Boston, MA'], workMode: 'Hybrid' },
      sourceClass: 'official-ats', sourceId: 'lever-acme', sourceUrl: 'https://api.lever.test/acme', observedAt, exactPosting: true,
    });
    const original = job({
      notification: { smsPending: true, digestPending: false, smsSentAt: observedAt },
      sourceReferences: [{ sourceId: 'lever-acme', document: '123', sourceUrl: 'https://api.lever.test/acme', row: 1,
        company: 'Acme', title: 'BS/MS Software Co-op — Hybrid', location: 'Boston, MA', season: 'summer-2027',
        applyUrl: 'https://careers.acme.test/jobs/123', compensation: { raw: '' }, state: 'open', metadataEvidence: metadata }],
      internshipIdentity: {
        company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance: [field] } },
        programType: { value: 'co-op', provenance: [field] }, season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance: [field] },
        education: { levels: [], evidenceStatus: 'unspecified', provenance: [] },
        title: { official: { value: 'BS/MS Software Co-op — Hybrid', provenance: [field] }, display: { value: 'BS/MS Software Co-op — Hybrid', provenance: [field] }, search: { value: 'bs ms software co op hybrid', provenance: [field] } },
        disciplines: [], locations: [],
      },
    });
    const projected = projectRoleMetadata(original).job;
    expect(projected).toMatchObject({ programType: 'co-op', workMode: 'hybrid', locations: ['Boston, MA'], graduationWindow: { start: '2027-05', end: '2028-06' } });
    expect(projected.jobId).toBe(original.jobId);
    expect(projected.notification).toEqual(original.notification);
    expect(projected.firstSeenAt).toBe(original.firstSeenAt);
  });
});
