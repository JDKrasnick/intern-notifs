import { describe, expect, it } from 'vitest';
import { legacyDeliveryExclusions, parseGroupedNotificationCohort } from '../src/grouped-notification-cohort.js';

describe('shared grouped-notification cohort', () => {
  it('parses the versioned deployment value used by every legacy provider worker', () => {
    expect([...parseGroupedNotificationCohort('v1: user-a, user-b,user-a')]).toEqual(['user-a', 'user-b']);
    expect(legacyDeliveryExclusions(parseGroupedNotificationCohort('v1:user-a'))).toMatchObject({
      excludeUserIds: new Set(['user-a']),
    });
  });

  it('can exclude all legacy delivery during a full grouped rollout', () => {
    expect(parseGroupedNotificationCohort('v1:*')).toBe('*');
    expect(legacyDeliveryExclusions('*')).toEqual({ excludeAllUsers: true });
  });
});
