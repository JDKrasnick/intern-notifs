import type { SourceReference } from '../types.js';
import { reviewedAshbySources } from './ashby-config.js';
import { reviewedGreenhouseSources } from './greenhouse-config.js';
import { reviewedLeverSources } from './lever-config.js';

type LabeledSource = { id: string; status: 'shadow' | 'published' };

const directProviderRegistries: ReadonlyArray<{
  label: string;
  sources: readonly LabeledSource[];
}> = [
  { label: 'Greenhouse', sources: reviewedGreenhouseSources },
  { label: 'Lever', sources: reviewedLeverSources },
  { label: 'Ashby', sources: reviewedAshbySources },
];

const publishedSourceLabels = new Map(
  directProviderRegistries.flatMap(({ label, sources }) => sources
    .filter((source) => source.status === 'published')
    .map((source) => [source.id, label] as const)),
);

export function notificationSourceLabelFor(references: readonly SourceReference[]): string {
  const labels = new Set(references
    .map((reference) => publishedSourceLabels.get(reference.sourceId))
    .filter((label): label is string => Boolean(label)));
  if (labels.size === 0) return 'Job board';
  if (labels.size === 1) return labels.values().next().value!;
  return 'Official careers site';
}
