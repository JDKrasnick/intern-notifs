import { reviewedAshbySources, type ReviewedAshbySource } from './sources/ashby-config.js';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from './sources/greenhouse-config.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { isProviderSourceDue } from './source-poll-cadence.js';
import type { SourceCheckpoint, SourceHealth } from './types.js';

export interface ProviderWorkMessage {
  version: 1;
  sourceId: string;
  scheduledAt: string;
  runId?: string;
  force?: boolean;
}

function messages<T extends { id: string }>(sources: T[], scheduledAt: Date, runId?: string): ProviderWorkMessage[] {
  const timestamp = scheduledAt.toISOString();
  return sources.map((source) => ({
    version: 1,
    sourceId: source.id,
    scheduledAt: timestamp,
    ...(runId ? { runId } : {}),
  }));
}

export function greenhouseWorkMessages(
  sources: ReviewedGreenhouseSource[] = reviewedGreenhouseSources,
  scheduledAt = new Date(),
) {
  const timestamp = scheduledAt.toISOString();
  return sources.map((source) => ({ version: 1 as const, sourceId: source.id, scheduledAt: timestamp }));
}

export function leverWorkMessages(
  sources: ReviewedLeverSource[] = reviewedLeverSources,
  scheduledAt = new Date(),
  runId?: string,
) {
  return messages(sources, scheduledAt, runId);
}

export function ashbyWorkMessages(
  sources: ReviewedAshbySource[] = reviewedAshbySources,
  scheduledAt = new Date(),
  runId?: string,
) {
  return messages(sources, scheduledAt, runId);
}

export function isGreenhouseSourceDue(source: ReviewedGreenhouseSource, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth) {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}

export function isLeverSourceDue(source: ReviewedLeverSource, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth) {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}

export function isAshbySourceDue(source: ReviewedAshbySource, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth) {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}
