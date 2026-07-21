import type { SourceAdapter } from '../types.js';
import { defaultSources as githubSources } from './github.js';
import { approvedLeverSources } from './lever.js';

/** All reviewed, production publication adapters. Discovery tooling never belongs here. */
export const defaultSources: SourceAdapter[] = [...githubSources, ...approvedLeverSources];
