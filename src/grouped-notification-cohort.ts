import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { parseGroupedNotificationCohort, type GroupedNotificationCohort } from './grouped-notification.js';

export const GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME = '/intern-notifs/grouped-notification-user-ids';
export { legacyDeliveryExclusions, parseGroupedNotificationCohort } from './grouped-notification.js';
export type { GroupedNotificationCohort } from './grouped-notification.js';

export async function loadGroupedNotificationCohort(
  parameterName: string,
  client = new SSMClient({}),
): Promise<GroupedNotificationCohort> {
  const value = (await client.send(new GetParameterCommand({ Name: parameterName }))).Parameter?.Value;
  if (value === undefined) throw new Error(`Grouped notification cohort parameter ${parameterName} has no value`);
  return parseGroupedNotificationCohort(value);
}
