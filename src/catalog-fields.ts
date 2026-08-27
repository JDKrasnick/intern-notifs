import type { Internship } from './types.js';
import { occurrenceProvenance } from './sources/provenance.js';

export type CatalogSource = 'all' | 'direct' | 'community' | 'corroborated';

export function catalogSearchText(job: Internship) {
  return `${job.company} ${job.title} ${job.location}`.toLowerCase();
}

export function catalogSourceClasses(job: Internship): CatalogSource[] {
  const direct = job.sourceReferences.some((reference) => {
    const provenance = occurrenceProvenance(reference);
    return provenance === 'official-ats' || provenance === 'official-structured' || provenance === 'employer-submitted';
  });
  const community = job.sourceReferences.some((reference) => occurrenceProvenance(reference) === 'reviewed-community');
  return ['all', ...(direct ? ['direct'] as const : []), ...(community ? ['community'] as const : []), ...(direct && community ? ['corroborated'] as const : [])];
}
