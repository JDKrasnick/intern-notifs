import { randomUUID } from 'node:crypto';
import { SourceFetchError } from './sources/source-error.js';
import type { SourceFailureCategory, SourceHealth, SourceRun } from './types.js';

const MAX_RECENT_RUNS = 25;
const QUALITY_FAILURES_BEFORE_QUARANTINE = 2;

export function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 500);
}

export function sourceFailureCategory(error: unknown): SourceFailureCategory {
  if (error instanceof SourceFetchError) {
    return error.category;
  }
  const message = safeDiagnostic(error).toLowerCase();
  if (/application link|application host|eligible .* link/.test(message)) return 'link';
  if (/shape|schema|malformed json/.test(message)) return 'json';
  if (/quality|suspicious zero-row/.test(message)) return 'quality';
  if (/timeout|timed out|aborted|fetch|network|socket|econn/.test(message)) return 'transport';
  return 'persistence';
}

function shouldQuarantine(category: SourceFailureCategory, error: unknown, failures: number): boolean {
  if (category === 'json' || category === 'identity') return true;
  if (category === 'http' && error instanceof SourceFetchError && [401, 403, 404].includes(error.status ?? 0)) return true;
  return (category === 'quality' || category === 'link' || category === 'empty') && failures >= QUALITY_FAILURES_BEFORE_QUARANTINE;
}

function withRun(previous: SourceHealth | undefined, run: SourceRun): SourceRun[] {
  return [run, ...(previous?.recentRuns ?? [])].slice(0, MAX_RECENT_RUNS);
}

export function successfulSourceHealth(input: {
  sourceId: string;
  previous?: SourceHealth;
  startedAt: string;
  completedAt: string;
  rawRows?: number;
  eligibleRows?: number;
  withheldRows?: number;
}): SourceHealth {
  const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt));
  const run: SourceRun = {
    runId: randomUUID(),
    sourceId: input.sourceId,
    state: 'succeeded',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs,
    ...(input.rawRows !== undefined ? { rawRows: input.rawRows } : {}),
    ...(input.eligibleRows !== undefined ? { eligibleRows: input.eligibleRows } : {}),
    ...(input.withheldRows !== undefined ? { withheldRows: input.withheldRows } : {}),
  };
  return {
    sourceId: input.sourceId,
    state: 'healthy',
    lastAttemptAt: input.completedAt,
    lastSuccessAt: input.completedAt,
    consecutiveFailures: 0,
    durationMs,
    ...(input.rawRows !== undefined ? { rawRows: input.rawRows } : {}),
    ...(input.eligibleRows !== undefined ? { eligibleRows: input.eligibleRows } : {}),
    ...(input.withheldRows !== undefined ? { withheldRows: input.withheldRows } : {}),
    recentRuns: withRun(input.previous, run),
  };
}

export function failedSourceHealth(input: {
  sourceId: string;
  previous?: SourceHealth;
  startedAt: string;
  completedAt: string;
  error: unknown;
}): SourceHealth {
  const category = sourceFailureCategory(input.error);
  const failures = (input.previous?.consecutiveFailures ?? 0) + 1;
  const quarantined = shouldQuarantine(category, input.error, failures);
  const diagnostic = safeDiagnostic(input.error);
  const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt));
  const run: SourceRun = {
    runId: randomUUID(),
    sourceId: input.sourceId,
    state: quarantined ? 'quarantined' : 'failed',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs,
    failureCategory: category,
    diagnostic,
  };
  return {
    sourceId: input.sourceId,
    state: quarantined ? 'quarantined' : 'degraded',
    lastAttemptAt: input.completedAt,
    ...(input.previous?.lastSuccessAt ? { lastSuccessAt: input.previous.lastSuccessAt } : {}),
    consecutiveFailures: failures,
    durationMs,
    failureCategory: category,
    diagnostic,
    ...(quarantined ? { quarantinedAt: input.completedAt, quarantineReason: diagnostic } : {}),
    ...(input.previous?.rawRows !== undefined ? { rawRows: input.previous.rawRows } : {}),
    ...(input.previous?.eligibleRows !== undefined ? { eligibleRows: input.previous.eligibleRows } : {}),
    ...(input.previous?.withheldRows !== undefined ? { withheldRows: input.previous.withheldRows } : {}),
    recentRuns: withRun(input.previous, run),
  };
}
