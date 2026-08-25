import { describe, expect, it } from 'vitest';
import { cleanBadgeText, locationSummary, normalizeCompensation, normalizeInternship, normalizeListing, normalizeLocations } from '../src/catalog-quality.js';
import type { Internship, ProcessedListing } from '../src/types.js';

const listing = (overrides: Partial<ProcessedListing> = {}): ProcessedListing => ({
  sourceId: 'greenhouse-acme', externalId: '1', document: '1', sourceUrl: 'https://boards.greenhouse.io/acme', row: 1,
  company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://example.test/1',
  compensation: { raw: '' }, state: 'open', fetchedAt: '2026-08-25T00:00:00.000Z', ...overrides,
});

describe('catalog quality normalization', () => {
  it('extracts only plausible USD pay expressions and preserves annual fields', () => {
    const pay = normalizeCompensation(`Benefits and legal prose ${'x'.repeat(400)}. Pay is $42 - $55 per hour or $87,360-$114,400/year. CAD 900/hour.`);
    expect(pay).toMatchObject({ minHourlyUSD: 42, maxHourlyUSD: 55, minAnnualUSD: 87_360, maxAnnualUSD: 114_400 });
    expect(pay.raw).toBe('$42 - $55 per hour · $87,360-$114,400/year');
    expect(pay.raw.length).toBeLessThanOrEqual(160);
    expect(normalizeCompensation('$2/hour and $9,000,000/year').raw).toBe('');
    expect(normalizeCompensation('CAD $50/hour').maxHourlyUSD).toBeUndefined();
  });

  it('cleans badges while retaining their structured meaning', () => {
    const normalized = normalizeListing(listing({ company: '🇺🇸 Acme', title: '🎓 Advanced Degree Required · ML Intern' }));
    expect(normalized).toMatchObject({ company: 'Acme', title: 'ML Intern', requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true } });
    expect(cleanBadgeText('Acme 🇺🇸')).toBe('Acme');
  });

  it('bounds, canonicalizes, and summarizes locations', () => {
    const locations = normalizeLocations(['NYC', 'New York, NY', 'SF', 'Washington DC', '3 locations', 'US Remote', ...Array.from({ length: 20 }, (_, index) => `Office ${index}`)]);
    expect(locations.slice(0, 4)).toEqual(['New York, NY', 'San Francisco, CA', 'Washington, DC', 'Remote — US']);
    expect(locations).toHaveLength(12);
    expect(locationSummary(locations)).toBe('New York, NY · San Francisco, CA + 10 more');
  });

  it('repairs internships without changing identity or notification state', () => {
    const source = listing({ company: `Acme ${'Inc '.repeat(80)}`, location: 'NYC', compensation: { raw: 'Long description. $50/hr.' } });
    const job: Internship = {
      ...source, jobId: 'preserved', normalizedUrl: source.applyUrl, fingerprint: 'old', sourceReferences: [source], open: true,
      firstSeenAt: source.fetchedAt, lastSeenAt: source.fetchedAt, notification: { smsPending: false, digestPending: true },
    };
    const repaired = normalizeInternship(job);
    expect(repaired.jobId).toBe('preserved');
    expect(repaired.notification).toEqual(job.notification);
    expect(repaired.company.length).toBeLessThanOrEqual(160);
    expect(repaired.locations).toEqual(['New York, NY']);
    expect(repaired.compensation.raw).toBe('$50/hr');
  });
});
