import { describe, expect, it } from 'vitest';
import { parseShadowPublicationPolicy, policyAllows, shadowExtractionEvidence } from '../src/shadow-publication.js';
import type { ShadowExtraction } from '../src/shadow-extraction.js';

const hash = 'a'.repeat(64);

describe('shadow publication policy', () => {
  it('fails closed for absent, malformed, duplicate, and unsupported policies', () => {
    expect(parseShadowPublicationPolicy(undefined).enabled).toBe(false);
    expect(parseShadowPublicationPolicy('{oops').enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['housing'], cohort: [] })).enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations', 'locations'], cohort: [] })).enabled).toBe(false);
  });

  it('requires all three exact cohort identity parts', () => {
    const policy = parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations'], cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] }));
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash })).toBe(true);
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '124', contentHash: hash })).toBe(false);
  });

  it('converts only supported, receipt-allowed fields with quoted provenance', () => {
    const extraction: ShadowExtraction = {
      classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
      fields: {
        compensation: { value: [{ min: 50, max: 60, currency: 'USD', period: 'hour' }], status: 'present', evidence: ['$50 - $60 per hour'], qualifiers: [] },
        locations: { value: ['Austin, TX'], status: 'present', evidence: ['Location: Austin, TX'], qualifiers: [] },
        workMode: { value: 'hybrid', status: 'present', evidence: ['Work mode: hybrid'], qualifiers: [] },
        housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      },
    };
    const evidence = shadowExtractionEvidence({ extraction, sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', contentHash: hash,
      observedAt: '2026-09-08T00:00:00.000Z', extractionVersion: 1, allowedFields: ['locations', 'workMode'] });
    expect(evidence?.compensationRanges).toBeUndefined();
    expect(evidence?.locations?.[0]).toMatchObject({ name: 'Austin, TX', workMode: 'unspecified' });
    expect(evidence?.workMode?.provenance[0]?.source).toBe('reviewed-shadow');
  });
});
