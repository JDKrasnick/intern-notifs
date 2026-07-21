import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { isTechnicalJob } from './core/filters.js';
import { validateApplicationUrl, type ApplicationUrlValidator } from './core/application-url.js';
import { defaultPushTemplates, ExpoPushPublisher, inspectExpoPushReceipts, NtfyPublisher, sendDigest, sendNewJobNotifications, sendPendingNotifications, SesEmailSender, type EmailSender, type PushPublisher } from './notifications.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import { defaultSources } from './sources/index.js';
import type { SourceAdapter } from './types.js';

export interface RuntimeConfig {
  /** Optional personal fallback topic. Public app alerts use Expo Push Service. */
  ntfyTopic?: string;
  ntfyEndpoint?: string;
  ntfyTitleTemplate?: string;
  ntfyDescriptionTemplate?: string;
  sesFrom: string;
  sesTo: string;
}

export async function loadRuntimeConfig(parameterName: string, client = new SSMClient({})): Promise<RuntimeConfig> {
  const value = (await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))).Parameter?.Value;
  if (!value) throw new Error(`Runtime configuration parameter ${parameterName} has no value`);
  const config = JSON.parse(value) as Partial<RuntimeConfig>;
  if (!config.sesFrom || !config.sesTo) throw new Error('Runtime configuration requires sesFrom and sesTo');
  return config as RuntimeConfig;
}

export interface RuntimeDependencies {
  store: InternshipStore;
  config: RuntimeConfig;
  sources?: SourceAdapter[];
  userStore?: UserStore;
  expoPublisher?: ExpoPushPublisher;
  /** Legacy test/CLI injection. */
  notificationPublisher?: PushPublisher;
  ntfyPublisher?: PushPublisher;
  emailSender?: EmailSender;
  /** Replaces live URL verification in deterministic tests. */
  linkValidator?: ApplicationUrlValidator;
}

export async function runRuntimeCommand(command: 'poll' | 'digest', dependencies: RuntimeDependencies) {
  if (command === 'poll') {
    const poll = await new Poller(
      dependencies.sources ?? defaultSources,
      dependencies.store,
      undefined,
      undefined,
      dependencies.linkValidator ?? validateApplicationUrl,
    ).poll();
    if (dependencies.userStore) {
      const publisher = dependencies.expoPublisher ?? new ExpoPushPublisher();
      const templates = { ...defaultPushTemplates, titleTemplate: dependencies.config.ntfyTitleTemplate ?? defaultPushTemplates.titleTemplate, descriptionTemplate: dependencies.config.ntfyDescriptionTemplate ?? defaultPushTemplates.descriptionTemplate };
      const ntfy = dependencies.config.ntfyTopic
        ? await sendPendingNotifications(dependencies.store, dependencies.ntfyPublisher ?? new NtfyPublisher(dependencies.config.ntfyTopic, dependencies.config.ntfyEndpoint), templates)
        : { sent: 0, failed: 0 };
      return { poll, notifications: await sendNewJobNotifications(poll.newJobs.filter(isTechnicalJob), dependencies.userStore, publisher), ntfy, receipts: await inspectExpoPushReceipts(dependencies.userStore, publisher) };
    }
    if (dependencies.notificationPublisher) {
      const { sendPendingNotifications } = await import('./notifications.js');
      return { poll, notifications: await sendPendingNotifications(dependencies.store, dependencies.notificationPublisher) };
    }
    return { poll, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  return { digested: await sendDigest(dependencies.store, dependencies.emailSender ?? new SesEmailSender(dependencies.config.sesFrom, dependencies.config.sesTo)) };
}

export async function runtimeHandler(event: { command?: string } = {}) {
  const command = event.command;
  if (command !== 'poll' && command !== 'digest') throw new Error('Scheduler event command must be poll or digest');
  const tableName = process.env.INTERNSHIPS_TABLE;
  const parameterName = process.env.RUNTIME_CONFIG_PARAMETER_NAME;
  const usersTable = process.env.USERS_TABLE;
  if (!tableName || !parameterName || !usersTable) throw new Error('INTERNSHIPS_TABLE, USERS_TABLE, and RUNTIME_CONFIG_PARAMETER_NAME are required');
  const result = await runRuntimeCommand(command, { store: new DynamoInternshipStore(tableName), userStore: new DynamoUserStore(usersTable), config: await loadRuntimeConfig(parameterName) });
  console.log(JSON.stringify({ command, ...result }));
  return result;
}
