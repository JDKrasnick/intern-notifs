import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { NtfyPublisher, sendDigest, sendPendingSms, SesEmailSender, type EmailSender, type PushPublisher } from './notifications.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, type InternshipStore } from './store.js';
import { defaultSources } from './sources/github.js';
import type { SourceAdapter } from './types.js';

export interface RuntimeConfig {
  ntfyTopic: string;
  sesFrom: string;
  sesTo: string;
}

export async function loadRuntimeConfig(parameterName: string, client = new SSMClient({})): Promise<RuntimeConfig> {
  const value = (await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))).Parameter?.Value;
  if (!value) throw new Error(`Runtime configuration parameter ${parameterName} has no value`);
  const config = JSON.parse(value) as Partial<RuntimeConfig>;
  if (!config.ntfyTopic || !config.sesFrom || !config.sesTo) throw new Error('Runtime configuration requires ntfyTopic, sesFrom, and sesTo');
  return config as RuntimeConfig;
}

export interface RuntimeDependencies {
  store: InternshipStore;
  config: RuntimeConfig;
  sources?: SourceAdapter[];
  notificationPublisher?: PushPublisher;
  emailSender?: EmailSender;
}

export async function runRuntimeCommand(command: 'poll' | 'digest', dependencies: RuntimeDependencies) {
  if (command === 'poll') {
    const poll = await new Poller(dependencies.sources ?? defaultSources, dependencies.store).poll();
    const notifications = await sendPendingSms(dependencies.store, dependencies.notificationPublisher ?? new NtfyPublisher(dependencies.config.ntfyTopic));
    return { poll, notifications };
  }
  return { digested: await sendDigest(dependencies.store, dependencies.emailSender ?? new SesEmailSender(dependencies.config.sesFrom, dependencies.config.sesTo)) };
}

export async function runtimeHandler(event: { command?: string } = {}) {
  const command = event.command;
  if (command !== 'poll' && command !== 'digest') throw new Error('Scheduler event command must be poll or digest');
  const tableName = process.env.INTERNSHIPS_TABLE;
  const parameterName = process.env.RUNTIME_CONFIG_PARAMETER_NAME;
  if (!tableName || !parameterName) throw new Error('INTERNSHIPS_TABLE and RUNTIME_CONFIG_PARAMETER_NAME are required');
  const result = await runRuntimeCommand(command, { store: new DynamoInternshipStore(tableName), config: await loadRuntimeConfig(parameterName) });
  console.log(JSON.stringify({ command, ...result }));
  return result;
}
