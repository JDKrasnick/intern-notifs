import { describe, expect, it } from 'vitest';
import { createLatestRequestGuard } from '../src/latest-request';

describe('latest request guard', () => {
  it('rejects a late response after another group opens', () => {
    const guard = createLatestRequestGuard();
    const groupA = guard.begin('group-a');
    const groupB = guard.begin('group-b');
    expect(guard.isCurrent(groupA, 'group-a')).toBe(false);
    expect(guard.isCurrent(groupB, 'group-b')).toBe(true);
  });

  it('rejects a response after the sheet is dismissed', () => {
    const guard = createLatestRequestGuard();
    const request = guard.begin('group-a');
    guard.invalidate();
    expect(guard.isCurrent(request, 'group-a')).toBe(false);
  });
});
