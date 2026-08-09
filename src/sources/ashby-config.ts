import type { ReviewedSourceRecord } from './reviewed-source.js';

export type ReviewedAshbySource = ReviewedSourceRecord & {
  identity: ReviewedSourceRecord['identity'] & { provider: 'ashby'; apiRegion: 'global' };
};

/** Human-reviewed Ashby boards consumed by the independent shadow/published runtime. */
export const reviewedAshbySources: ReviewedAshbySource[] = [
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
  {
    id: 'ashby-notion', company: 'Notion', identity: { provider: 'ashby', boardKey: 'notion', apiRegion: 'global' },
    careersUrl: 'https://www.notion.com/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-alan', company: 'Alan', identity: { provider: 'ashby', boardKey: 'alan', apiRegion: 'global' },
    careersUrl: 'https://alan.com/en/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-base-power', company: 'Base Power', identity: { provider: 'ashby', boardKey: 'base-power', apiRegion: 'global' },
    careersUrl: 'https://www.basepowercompany.com/open-roles', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-reonic', company: 'Reonic', identity: { provider: 'ashby', boardKey: 'reonic', apiRegion: 'global' },
    careersUrl: 'https://reonic.com/en-ca/about/jobs/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-terranova', company: 'Terranova', identity: { provider: 'ashby', boardKey: 'Terranova', apiRegion: 'global' },
    careersUrl: 'https://www.terranova.inc/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-melius', company: 'Melius', identity: { provider: 'ashby', boardKey: 'melius', apiRegion: 'global' },
    careersUrl: 'https://www.melius.com/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-rho', company: 'Rho', identity: { provider: 'ashby', boardKey: 'rho', apiRegion: 'global' },
    careersUrl: 'https://www.rho.co/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-ctgt', company: 'CTGT', identity: { provider: 'ashby', boardKey: 'ctgt', apiRegion: 'global' },
    careersUrl: 'https://www.ctgt.ai/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-opusclip', company: 'OpusClip', identity: { provider: 'ashby', boardKey: 'opusclip', apiRegion: 'global' },
    careersUrl: 'https://www.opus.pro/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-windborne-systems', company: 'WindBorne Systems', identity: { provider: 'ashby', boardKey: 'windborne-systems', apiRegion: 'global' },
    careersUrl: 'https://windbornesystems.com/careers/firmware-intern', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-persona-ai', company: 'Persona AI', identity: { provider: 'ashby', boardKey: 'persona.ai', apiRegion: 'global' },
    careersUrl: 'https://persona.ai/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-skydio', company: 'Skydio', identity: { provider: 'ashby', boardKey: 'skydio', apiRegion: 'global' },
    careersUrl: 'https://www.skydio.com/jobs/cc83824e-a1cd-4bc7-9206-7264da9fbd61/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-heliux', company: 'Heliux', identity: { provider: 'ashby', boardKey: 'heliux', apiRegion: 'global' },
    careersUrl: 'https://www.heliux.com/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-beaconsoftware', company: 'Beacon Software', identity: { provider: 'ashby', boardKey: 'beaconsoftware', apiRegion: 'global' },
    careersUrl: 'https://www.beaconsoftware.com/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-centerfield', company: 'Centerfield', identity: { provider: 'ashby', boardKey: 'centerfield', apiRegion: 'global' },
    careersUrl: 'https://www.centerfield.com/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-rivianvw-tech', company: 'RV Tech', identity: { provider: 'ashby', boardKey: 'rivianvw.tech', apiRegion: 'global' },
    careersUrl: 'https://rivianvw.tech/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
];

/** Ordered expansion replacements; none is reviewed or admitted. */
export const ashbyExpansionFallbacks = [
  { priority: 1, company: 'Circleback', boardName: 'circleback', observedBoardUrl: 'https://jobs.ashbyhq.com/circleback' },
  { priority: 2, company: 'Eragon', boardName: 'eragon', observedBoardUrl: 'https://jobs.ashbyhq.com/eragon' },
  { priority: 3, company: 'Modal', boardName: 'modal', observedBoardUrl: 'https://jobs.ashbyhq.com/modal' },
  { priority: 4, company: 'Yotta', boardName: 'yotta', observedBoardUrl: 'https://jobs.ashbyhq.com/yotta' },
  { priority: 5, company: 'Anthelion Capital', boardName: 'anthelioncap', observedBoardUrl: 'https://jobs.ashbyhq.com/anthelioncap' },
  { priority: 6, company: 'Saronic', boardName: 'saronic', observedBoardUrl: 'https://jobs.ashbyhq.com/saronic' },
] as const;
