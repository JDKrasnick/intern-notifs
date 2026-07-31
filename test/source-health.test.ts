import { describe, expect, it } from 'vitest';
import { failedSourceHealth, sourceFailureCategory, successfulSourceHealth } from '../src/source-health.js';
import { SourceFetchError } from '../src/sources/source-error.js';

describe('source health', () => {
  it('keeps temporary transport failures degraded and retains the last success', () => {
    const previous = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      eligibleRows: 2,
    });
    const health = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      previous,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:02.000Z',
      error: new SourceFetchError('request timed out', 'transport'),
    });
    expect(health).toMatchObject({
      state: 'degraded',
      lastSuccessAt: '2026-07-29T12:00:01.000Z',
      consecutiveFailures: 1,
      failureCategory: 'transport',
      outcome: 'temporary_provider_error',
      backoffUntil: '2026-07-29T12:11:02.000Z',
    });
  });

  it('quarantines deterministic schema failures immediately', () => {
    const health = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new SourceFetchError('response shape was invalid', 'json'),
    });
    expect(health.state).toBe('quarantined');
    expect(health.quarantineReason).toContain('shape');
  });

  it('requires repeated link-health failures before source quarantine', () => {
    const first = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new Error('2/3 eligible Greenhouse application links failed validation'),
    });
    const second = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      previous: first,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
      error: new Error('2/3 eligible Greenhouse application links failed validation'),
    });
    expect(sourceFailureCategory(new Error('application link timed out'))).toBe('link');
    expect(first.state).toBe('degraded');
    expect(second.state).toBe('quarantined');
    expect(second.recentRuns).toHaveLength(2);
  });

  it('returns a quarantined source to healthy after a clean run', () => {
    const quarantined = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new SourceFetchError('malformed JSON', 'json'),
    });
    const recovered = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      previous: quarantined,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
      rawRows: 4,
      eligibleRows: 1,
    });
    expect(recovered).toMatchObject({ state: 'healthy', consecutiveFailures: 0, rawRows: 4, eligibleRows: 1 });
  });
});
