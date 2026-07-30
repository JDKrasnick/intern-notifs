import type { SourceAdapter } from '../types.js';
import { defaultSources as githubSources } from './github.js';
import { reviewedGreenhouseSources } from './greenhouse-config.js';
import { reviewedLeverSources } from './lever-config.js';

/**
 * Sources handled by the general poll Lambda. Reviewed Greenhouse and Lever
 * boards use dedicated FIFO queues so provider failures cannot extend or fail
 * this catalog-wide polling run.
 */
export const defaultSources: SourceAdapter[] = [...githubSources];

/**
 * Application URLs pointing into a board this catalog already polls can be
 * attributed from the board's own checkpoint instead of by fetching the page.
 * Board tokens map to source IDs through the registries because neither is
 * derivable from the other: Lever's PlusAI site is `plus-2`.
 */
export function reviewedBoardIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const source of reviewedGreenhouseSources) index.set(`greenhouse:${source.boardToken.toLowerCase()}`, source.id);
  for (const source of reviewedLeverSources) index.set(`lever:${source.site.toLowerCase()}`, source.id);
  return index;
}
