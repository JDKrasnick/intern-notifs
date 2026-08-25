import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export const GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME = '/intern-notifs/grouped-notification-user-ids';
export type GroupedNotificationCohort = ReadonlySet<string> | '*';

export function parseGroupedNotificationCohort(value: string | undefined): GroupedNotificationCohort {
  const stored = value?.startsWith('v1:') ? value.slice(3) : value ?? '';
  const userIds = stored.split(',').map((item) => item.trim()).filter(Boolean);
  return userIds.includes('*') ? '*' : new Set(userIds);
}

export async function loadGroupedNotificationCohort(
  parameterName: string,
  client = new SSMClient({}),
): Promise<GroupedNotificationCohort> {
  const value = (await client.send(new GetParameterCommand({ Name: parameterName }))).Parameter?.Value;
  if (value === undefined) throw new Error(`Grouped notification cohort parameter ${parameterName} has no value`);
  return parseGroupedNotificationCohort(value);
}

export function legacyDeliveryExclusions(cohort: GroupedNotificationCohort) {
  return cohort === '*' ? { excludeAllUsers: true } : { excludeUserIds: cohort };
}
