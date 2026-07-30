import type { SourceAdapter } from '../types.js';
import { defaultSources as githubSources } from './github.js';
import { reviewedGreenhouseSources } from './greenhouse-config.js';
import { reviewedLeverSources } from './lever-config.js';
import { approvedLeverSources } from './lever.js';

/**
 * Sources handled by the general poll Lambda. Greenhouse boards intentionally
 * use their dedicated FIFO queue so 150+ boards cannot extend or fail this
 * catalog-wide polling run.
 */
export const defaultSources: SourceAdapter[] = [...githubSources, ...approvedLeverSources];

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
