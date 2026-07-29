import type { SourceAdapter } from '../types.js';
import { defaultSources as githubSources } from './github.js';
import { reviewedGreenhouseSources } from './greenhouse-config.js';
import { greenhouseAdapters } from './greenhouse.js';
import { approvedLeverSources } from './lever.js';

/**
 * Production publication adapters only. Greenhouse entries remain fail-closed
 * per board and use the poller's per-source quiet baseline on first fetch.
 */
export const defaultSources: SourceAdapter[] = [
  ...githubSources,
  ...approvedLeverSources,
  ...greenhouseAdapters(reviewedGreenhouseSources.filter((source) => source.status === 'published')),
];
