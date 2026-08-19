import { describe, expect, it } from 'vitest';
import { canonicalPostingTiming, formatPostingDate, publishedTimestamp } from '../src/core/posting-time.js';
import type { Internship } from '../src/types.js';

const reference = (sourceId: string, value: string, semantics: 'published' | 'updated' = 'published') => ({
  sourceId,
  document: 'role',
  sourceUrl: 'https://example.test/role',
  row: 1,
  company: 'Acme',
  title: 'Engineering Intern',
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: 'https://example.test/apply',
  compensation: { raw: '' },
  state: 'open' as const,
  postedAt: value,
  providerTimestamp: { value, semantics },
});

describe('canonical posting time', () => {
  it('prefers an official publication timestamp over a community date', () => {
    expect(publishedTimestamp([
      reference('community-list', '2026-08-19T15:00:00Z'),
      reference('ashby-acme', '2025-09-22T20:57:32Z'),
    ])).toBe('2025-09-22T20:57:32Z');
    expect(canonicalPostingTiming({
      firstSeenAt: '2026-08-19T15:18:03Z',
      sourceReferences: [reference('community-list', '2026-08-19T15:00:00Z'), reference('ashby-acme', '2025-09-22T20:57:32Z')],
    })).toEqual({ kind: 'employer-posted', timestamp: '2025-09-22T20:57:32Z' });
  });

  it('keeps an absolute community date explicitly unverified', () => {
    expect(canonicalPostingTiming({
      firstSeenAt: '2026-08-19T15:18:03Z',
      sourceReferences: [reference('community-list', '2026-08-19T15:00:00Z')],
    })).toEqual({ kind: 'source-reported', timestamp: '2026-08-19T15:00:00Z' });
  });

  it('falls back to when InternNotifs found the role for relative or updated values', () => {
    const job = {
      firstSeenAt: '2026-08-19T15:18:03Z',
      sourceReferences: [reference('community-list', '21m')],
    } as Pick<Internship, 'firstSeenAt' | 'sourceReferences'>;
    expect(canonicalPostingTiming(job)).toEqual({ kind: 'found', timestamp: '2026-08-19T15:18:03Z' });
    expect(canonicalPostingTiming({ ...job, sourceReferences: [reference('greenhouse-acme', '2026-08-19T16:00:00Z', 'updated')] })).toEqual({ kind: 'found', timestamp: '2026-08-19T15:18:03Z' });
  });

  it('formats dates consistently for alerts', () => {
    expect(formatPostingDate('2025-09-22T20:57:32Z')).toBe('Sep 22, 2025');
  });
});
