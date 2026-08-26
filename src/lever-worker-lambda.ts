import { processLeverQueue } from './lever-worker.js';
import { loadGroupedNotificationCohort } from './grouped-notification-cohort.js';
import { DynamoInternshipStore, DynamoUserStore } from './store.js';

export async function handler(event: Parameters<typeof processLeverQueue>[0], context?: { awsRequestId?: string }) {
  const tableName = process.env.INTERNSHIPS_TABLE;
  const usersTable = process.env.USERS_TABLE;
  const cohortParameterName = process.env.GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME;
  if (!tableName || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  if (!cohortParameterName) throw new Error('GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME is required');
  return processLeverQueue(event, {
    store: new DynamoInternshipStore(tableName),
    userStore: new DynamoUserStore(usersTable),
    groupedNotificationCohort: await loadGroupedNotificationCohort(cohortParameterName),
  }, context);
}
