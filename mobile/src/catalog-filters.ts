export type GroupedCatalogFilterState = {
  query?: string;
  source: 'all' | 'direct' | 'community' | 'corroborated';
  status: 'open' | 'closed';
  employerCategory: 'all' | 'faang' | 'startup' | 'normal';
  hideUsCitizenshipRequired: boolean;
  hideAdvancedDegreeRequired: boolean;
};

export function groupedCatalogParameters(
  state: GroupedCatalogFilterState,
  page: { limit?: number; cursor?: string } = {},
) {
  const params = new URLSearchParams({ limit: String(page.limit ?? 25), status: state.status });
  if (page.cursor) params.set('cursor', page.cursor);
  if (state.query?.trim()) params.set('q', state.query.trim());
  if (state.source !== 'all') params.set('source', state.source);
  if (state.employerCategory !== 'all') params.set('employerCategory', state.employerCategory);
  if (state.hideUsCitizenshipRequired) params.set('hideUsCitizenshipRequired', 'true');
  if (state.hideAdvancedDegreeRequired) params.set('hideAdvancedDegreeRequired', 'true');
  return params;
}

export function catalogGroupAvailabilityLabel(
  group: { kind: 'program-group' | 'employer-release' | 'individual'; roleCount: number },
  status: 'open' | 'closed',
) {
  if (status === 'closed') return `${group.roleCount} closed role${group.roleCount === 1 ? '' : 's'}`;
  if (group.kind === 'employer-release') return `${group.roleCount} new roles`;
  if (group.kind === 'program-group') return `${group.roleCount} roles in this program`;
  return '1 open role';
}
