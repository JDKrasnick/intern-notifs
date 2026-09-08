export type GroupedCatalogFilterState = {
  query?: string;
  source: 'all' | 'direct' | 'community' | 'corroborated';
  status: 'open' | 'closed';
  employerCategory: 'all' | 'faang' | 'startup' | 'normal';
  disciplines?: string[];
  seasons?: string[];
  workModes?: string[];
  educationLevels?: string[];
  hasCompensation?: boolean;
  hideUsCitizenshipRequired: boolean;
  hideAdvancedDegreeRequired: boolean;
};

export type ChipOption = { value: string; label: string };

/** Grounded in live catalog data: Summer 2027 dominates; these four cover dated roles. */
export const seasonFilterOptions: ChipOption[] = [
  { value: 'summer-2027', label: 'Summer 2027' },
  { value: 'fall-2026', label: 'Fall 2026' },
  { value: 'winter-2027', label: 'Winter 2027' },
  { value: 'spring-2027', label: 'Spring 2027' },
];

export const workModeFilterOptions: ChipOption[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
];

export const educationFilterOptions: ChipOption[] = [
  { value: 'undergraduate', label: 'Undergrad' },
  { value: 'masters', label: 'Masters' },
  { value: 'mba', label: 'MBA' },
  { value: 'doctoral', label: 'Doctoral' },
];

export function groupedCatalogParameters(
  state: GroupedCatalogFilterState,
  page: { limit?: number; cursor?: string } = {},
) {
  const params = new URLSearchParams({ limit: String(page.limit ?? 25), status: state.status });
  if (page.cursor) params.set('cursor', page.cursor);
  if (state.query?.trim()) params.set('q', state.query.trim());
  if (state.source !== 'all') params.set('source', state.source);
  if (state.employerCategory !== 'all') params.set('employerCategory', state.employerCategory);
  if (state.disciplines?.length) params.set('disciplines', state.disciplines.join(','));
  if (state.seasons?.length) params.set('seasons', state.seasons.join(','));
  if (state.workModes?.length) params.set('workModes', state.workModes.join(','));
  if (state.educationLevels?.length) params.set('educationLevels', state.educationLevels.join(','));
  if (state.hasCompensation) params.set('hasCompensation', 'true');
  if (state.hideUsCitizenshipRequired) params.set('hideUsCitizenshipRequired', 'true');
  if (state.hideAdvancedDegreeRequired) params.set('hideAdvancedDegreeRequired', 'true');
  return params;
}

export type CatalogFilterValues = {
  disciplines: string[];
  seasons: string[];
  workModes: string[];
  educationLevels: string[];
  employerFilter: 'all' | 'faang' | 'startup' | 'normal';
  jobStatus: 'open' | 'closed';
  sourceFilter: 'all' | 'direct' | 'community' | 'corroborated';
  hasCompensation: boolean;
  hideUsCitizenshipRequired: boolean;
  hideAdvancedDegreeRequired: boolean;
};

export const emptyCatalogFilters: CatalogFilterValues = {
  disciplines: [],
  seasons: [],
  workModes: [],
  educationLevels: [],
  employerFilter: 'all',
  jobStatus: 'open',
  sourceFilter: 'all',
  hasCompensation: false,
  hideUsCitizenshipRequired: false,
  hideAdvancedDegreeRequired: false,
};

export function countActiveCatalogFilters(filters: CatalogFilterValues): number {
  return [
    filters.disciplines.length > 0,
    filters.seasons.length > 0,
    filters.workModes.length > 0,
    filters.educationLevels.length > 0,
    filters.employerFilter !== 'all',
    filters.jobStatus !== 'open',
    filters.sourceFilter !== 'all',
    filters.hasCompensation,
    filters.hideUsCitizenshipRequired,
    filters.hideAdvancedDegreeRequired,
  ].filter(Boolean).length;
}

export function catalogGroupAvailabilityLabel(
  group: { kind: 'program-group' | 'employer-release' | 'individual'; roleCount: number },
  status: 'open' | 'closed',
) {
  if (status === 'closed') return `${group.roleCount} closed role${group.roleCount === 1 ? '' : 's'}`;
  if (group.roleCount === 1) return 'Open role';
  if (group.kind === 'employer-release') return `${group.roleCount} new role${group.roleCount === 1 ? '' : 's'}`;
  if (group.kind === 'program-group') return `${group.roleCount} role${group.roleCount === 1 ? '' : 's'} in this program`;
  return '1 open role';
}
