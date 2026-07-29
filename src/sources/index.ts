import type { SourceAdapter } from '../types.js';
import { defaultSources as githubSources } from './github.js';
import { approvedLeverSources } from './lever.js';

/**
 * Production publication adapters only. Greenhouse admission and reader
 * contracts are deliberately isolated until its snapshot/shadow rollout is
 * explicitly enabled in the next delivery part.
 */
export const defaultSources: SourceAdapter[] = [...githubSources, ...approvedLeverSources];
