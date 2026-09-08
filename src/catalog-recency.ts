import type { Internship } from './types.js';

export type CatalogRecency = NonNullable<Internship['catalogRecency']>;

/** Legacy rows predate explicit catalog recency and are normal catalog entries. */
export function catalogRecency(job: Internship): CatalogRecency {
  return job.catalogRecency ?? 'normal';
}

/** Legacy rows became visible when InternNotifs first observed them. */
export function catalogVisibleAt(job: Internship): string {
  return job.catalogVisibleAt ?? job.firstSeenAt;
}

export function canonicalCatalogRecency(job: Internship): Internship {
  // Admission-managed roles can exist durably before their first publication.
  // Do not synthesize visibility metadata for that hidden state.
  if (job.admission?.catalogEligible === false && !job.catalogVisibleAt) return job;
  if (job.catalogRecency && job.catalogVisibleAt) return job;
  return {
    ...job,
    catalogRecency: catalogRecency(job),
    catalogVisibleAt: catalogVisibleAt(job),
  };
}

/**
 * DynamoDB returns this key descending. Rank 3 keeps normal rows first, rank 1
 * keeps baselines last, and legacy ISO keys (which start with 2) remain between
 * them until the catalog-index audit rewrites those rows.
 */
export function openCatalogSortKey(job: Internship): string {
  const rank = catalogRecency(job) === 'normal' ? '3' : '1';
  return `${rank}#${catalogVisibleAt(job)}#${job.jobId}`;
}

export function compareCatalogRecency(left: Internship, right: Internship): number {
  const classDifference = Number(catalogRecency(right) === 'normal') - Number(catalogRecency(left) === 'normal');
  return classDifference
    || catalogVisibleAt(right).localeCompare(catalogVisibleAt(left))
    || right.jobId.localeCompare(left.jobId);
}
