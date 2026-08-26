import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { auditCatalogIndexes, emitCatalogIndexAuditMetric } from './catalog-index-audit.js';
import { SesEmailSender } from './aws-email.js';
import { DynamoInternshipStore, DynamoUserStore } from './store.js';
import { catalogGroupDetails, groupCatalogJobs } from './catalog-groups.js';
import { loadGroupedNotificationCohort } from './grouped-notification-cohort.js';
import { runRuntimeCommand, type RuntimeConfig } from './runtime-core.js';

export { runRuntimeCommand } from './runtime-core.js';
export type { RuntimeConfig, RuntimeDependencies } from './runtime-core.js';

export async function loadRuntimeConfig(parameterName: string, client = new SSMClient({})): Promise<RuntimeConfig> {
  const value = (await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))).Parameter?.Value;
  if (!value) throw new Error(`Runtime configuration parameter ${parameterName} has no value`);
  const config = JSON.parse(value) as Partial<RuntimeConfig>;
  if (!config.sesFrom || !config.sesTo) throw new Error('Runtime configuration requires sesFrom and sesTo');
  return config as RuntimeConfig;
}

export async function runtimeHandler(event: { command?: string } = {}) {
  const command = event.command;
  if (command !== 'poll' && command !== 'digest' && command !== 'audit-catalog-indexes' && command !== 'refresh-catalog-groups') throw new Error('Scheduler event command must be poll, digest, audit-catalog-indexes, or refresh-catalog-groups');
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  if (command === 'audit-catalog-indexes') {
    const result = await auditCatalogIndexes(tableName, DynamoDBDocumentClient.from(new DynamoDBClient({})));
    emitCatalogIndexAuditMetric(result);
    return result;
  }
  if (command === 'refresh-catalog-groups') {
    const store = new DynamoInternshipStore(tableName);
    const groups = groupCatalogJobs(await store.listCatalog(), { includeClosed: true }).map(catalogGroupDetails);
    const generatedAt = new Date().toISOString();
    await store.putCatalogProjection?.(groups, generatedAt);
    return { generatedAt, groups: groups.length, roles: groups.reduce((total, group) => total + group.roles.length, 0) };
  }
  const parameterName = process.env.RUNTIME_CONFIG_PARAMETER_NAME;
  const usersTable = process.env.USERS_TABLE;
  if (!parameterName || !usersTable) throw new Error('USERS_TABLE and RUNTIME_CONFIG_PARAMETER_NAME are required');
  const cohortParameterName = process.env.GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME;
  if (!cohortParameterName) throw new Error('GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME is required');
  const cohort = await loadGroupedNotificationCohort(cohortParameterName);
  const config = await loadRuntimeConfig(parameterName);
  const result = await runRuntimeCommand(command, {
    store: new DynamoInternshipStore(tableName), userStore: new DynamoUserStore(usersTable), config,
    groupedPipelineUserIds: cohort,
    ...(command === 'digest' ? { emailSender: new SesEmailSender(config.sesFrom, config.sesTo) } : {}),
  });
  console.log(JSON.stringify({ command, ...result }));
  return result;
}
