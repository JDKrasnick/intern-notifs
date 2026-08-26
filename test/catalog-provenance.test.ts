import { describe, expect, it } from 'vitest';
import { catalogSourceClasses } from '../src/catalog-fields.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { Internship, OccurrenceProvenance, SourceOccurrence } from '../src/types.js';

function occurrence(sourceId: string, provenance: OccurrenceProvenance, state: 'open' | 'closed' = 'open'): SourceOccurrence {
  return {
    sourceId, provenance, externalId: sourceId, document: sourceId,
    sourceUrl: `https://careers.example.test/${sourceId}`, row: 1,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote',
    season: 'summer-2027', applyUrl: 'https://careers.example.test/apply/1',
    compensation: { raw: '' }, state,
  };
}

function job(references: SourceOccurrence[]): Internship {
  return {
    jobId: 'role-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote',
    season: 'summer-2027', applyUrl: 'https://careers.example.test/apply/1',
    normalizedUrl: 'https://careers.example.test/apply/1', fingerprint: 'role-1', compensation: { raw: '' },
    sourceReferences: references, technical: true, open: true,
    firstSeenAt: '2026-08-26T00:00:00.000Z', catalogVisibleAt: '2026-08-26T00:00:00.000Z',
    lastSeenAt: '2026-08-26T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
  };
}

describe('catalog occurrence provenance', () => {
  it('uses explicit provenance rather than source-ID patterns', () => {
    const role = job([occurrence('totally-custom-id', 'official-structured')]);
    expect(catalogSourceClasses(role)).toEqual(['all', 'direct']);
  });

  it('retains employer, official, and community labels when sources corroborate a role', () => {
    const role = job([
      occurrence('employer:acme:submission:1', 'employer-submitted'),
      occurrence('custom-feed', 'official-ats'),
      occurrence('reviewed-list', 'reviewed-community'),
    ]);
    const details = catalogGroupDetails(groupCatalogJobs([role])[0]!);
    expect(details.roles[0]?.provenanceLabels).toEqual([
      'Employer submitted', 'Official ATS', 'Reviewed community source',
    ]);
    expect(details.roles[0]?.sourceCredibility).toBe('corroborated');
    expect(details.roles[0]?.workAuthorizationStatus).toBe('unknown');
  });

  it('does not show employer attribution for a closed submitted occurrence', () => {
    const role = job([
      occurrence('employer:acme:submission:1', 'employer-submitted', 'closed'),
      occurrence('official', 'official-ats'),
    ]);
    const details = catalogGroupDetails(groupCatalogJobs([role])[0]!);
    expect(details.roles[0]?.provenanceLabels).toEqual(['Official ATS']);
  });
});
