import { describe, expect, it } from 'vitest';
import { catalogGroupAvailabilityLabel, groupedCatalogParameters } from '../src/catalog-filters';

describe('grouped catalog request filters', () => {
  it('carries the same filters from a catalog row into group details', () => {
    const state = {
      query: 'machine learning', source: 'direct' as const, status: 'closed' as const,
      employerCategory: 'startup' as const, hideUsCitizenshipRequired: true, hideAdvancedDegreeRequired: true,
    };
    const params = groupedCatalogParameters(state);
    expect(Object.fromEntries(params)).toEqual({
      limit: '25', status: 'closed', q: 'machine learning', source: 'direct', employerCategory: 'startup',
      hideUsCitizenshipRequired: 'true', hideAdvancedDegreeRequired: 'true',
    });
  });
  it('labels closed cards as closed for both visible and accessibility copy', () => {
    expect(catalogGroupAvailabilityLabel({ kind: 'individual', roleCount: 1 }, 'closed')).toBe('1 closed role');
    expect(catalogGroupAvailabilityLabel({ kind: 'program-group', roleCount: 2 }, 'closed')).toBe('2 closed roles');
  });
  it('uses grammatical singular and plural availability copy for open groups', () => {
    expect(catalogGroupAvailabilityLabel({ kind: 'program-group', roleCount: 1 }, 'open')).toBe('1 role in this program');
    expect(catalogGroupAvailabilityLabel({ kind: 'program-group', roleCount: 2 }, 'open')).toBe('2 roles in this program');
    expect(catalogGroupAvailabilityLabel({ kind: 'employer-release', roleCount: 1 }, 'open')).toBe('1 new role');
    expect(catalogGroupAvailabilityLabel({ kind: 'employer-release', roleCount: 2 }, 'open')).toBe('2 new roles');
  });
});
