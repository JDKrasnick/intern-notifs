import type { Internship } from './types.js';

export type CatalogSource = 'all' | 'direct' | 'community' | 'corroborated';

export function catalogSearchText(job: Internship) {
  return `${job.company} ${job.title} ${job.location}`.toLowerCase();
}

export function catalogSourceClasses(job: Internship): CatalogSource[] {
  const direct = job.sourceReferences.some((reference) => /^(greenhouse|lever|ashby)-/i.test(reference.sourceId));
  // Community rows come from GitHub Markdown adapters. Their configured IDs
  // are publisher-specific, while persisted source URLs use raw.githubusercontent.com.
  const community = job.sourceReferences.some((reference) => /^github-/i.test(reference.sourceId)
    || /(?:^|\/\/)(?:raw\.)?github(?:usercontent)?\.com(?:[/:]|$)/i.test(reference.sourceUrl));
  return ['all', ...(direct ? ['direct'] as const : []), ...(community ? ['community'] as const : []), ...(direct && community ? ['corroborated'] as const : [])];
}
