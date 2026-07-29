import type { SourceAdapter } from '../types.js';
import { defaultSources as githubSources } from './github.js';
import { approvedLeverSources } from './lever.js';

/**
 * Sources handled by the general poll Lambda. Greenhouse boards intentionally
 * use their dedicated FIFO queue so 150+ boards cannot extend or fail this
 * catalog-wide polling run.
 */
export const defaultSources: SourceAdapter[] = [...githubSources, ...approvedLeverSources];
