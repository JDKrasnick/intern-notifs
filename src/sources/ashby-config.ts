import type { ReviewedSourceRecord } from './reviewed-source.js';

/** Human-reviewed Ashby boards. Runtime scheduling and publication are intentionally deferred. */
export const reviewedAshbySources: ReviewedSourceRecord[] = [
  {
    id: 'ashby-etched', company: 'Etched', identity: { provider: 'ashby', boardKey: 'etched', apiRegion: 'global' },
    careersUrl: 'https://www.etched.com/join', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-deepgram', company: 'Deepgram', identity: { provider: 'ashby', boardKey: 'Deepgram', apiRegion: 'global' },
    careersUrl: 'https://deepgram.com/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-cohere', company: 'Cohere', identity: { provider: 'ashby', boardKey: 'cohere', apiRegion: 'global' },
    careersUrl: 'https://cohere.com/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-mistral-ai', company: 'Mistral AI', identity: { provider: 'ashby', boardKey: 'mistral.ai', apiRegion: 'global' },
    careersUrl: 'https://mistral.ai/careers/', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-partly', company: 'Partly', identity: { provider: 'ashby', boardKey: 'partly.com', apiRegion: 'global' },
    careersUrl: 'https://www.partly.com/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
];

/** Observed first-party leads only; neither fallback is reviewed or admitted. */
export const ashbyPilotFallbacks = [
  {
    priority: 1, company: 'Alan', boardName: 'alan', careersUrl: 'https://alan.com/careers',
    observedBoardUrl: 'https://jobs.ashbyhq.com/alan', reviewState: 'pending-review',
  },
  {
    priority: 2, company: 'Notion', boardName: 'notion', careersUrl: 'https://www.notion.com/careers',
    observedBoardUrl: 'https://jobs.ashbyhq.com/notion/00f42dd8-c3b3-45cf-829e-550b675b3dd8', reviewState: 'pending-review',
  },
] as const;
