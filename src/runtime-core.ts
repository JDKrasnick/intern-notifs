import { validateApplicationUrlWithEvidence, type ApplicationUrlValidator } from './core/application-url.js';
import { defaultPushTemplates, ExpoPushPublisher, inspectExpoPushReceipts, NtfyPublisher, retryExpoPushNotifications, sendDigest, sendNewJobNotifications, sendPendingNotifications, type EmailSender, type PushPublisher } from './notifications.js';
import { Poller } from './poll.js';
import type { InternshipStore, UserStore } from './store.js';
import { defaultSources } from './sources/index.js';
import type { SourceAdapter } from './types.js';

export interface RuntimeConfig {
  ntfyTopic?: string;
  ntfyEndpoint?: string;
  ntfyTitleTemplate?: string;
  ntfyDescriptionTemplate?: string;
  sesFrom: string;
  sesTo: string;
}

export interface RuntimeDependencies {
  store: InternshipStore;
  config: RuntimeConfig;
  sources?: SourceAdapter[];
  userStore?: UserStore;
  expoPublisher?: ExpoPushPublisher;
  notificationPublisher?: PushPublisher;
  ntfyPublisher?: PushPublisher;
  emailSender?: EmailSender;
  linkValidator?: ApplicationUrlValidator;
  groupedPipelineUserIds?: ReadonlySet<string> | '*';
  validateCatalogOnPoll?: boolean;
}

export async function runRuntimeCommand(command: 'poll' | 'digest', dependencies: RuntimeDependencies) {
  if (command === 'poll') {
    const poll = await new Poller(
      dependencies.sources ?? defaultSources,
      dependencies.store,
      undefined,
      undefined,
      dependencies.linkValidator ?? validateApplicationUrlWithEvidence,
      dependencies.validateCatalogOnPoll === false ? false : undefined,
    ).poll();
    if (dependencies.userStore) {
      const publisher = dependencies.expoPublisher ?? new ExpoPushPublisher();
      const templates = { ...defaultPushTemplates, titleTemplate: dependencies.config.ntfyTitleTemplate ?? defaultPushTemplates.titleTemplate, descriptionTemplate: dependencies.config.ntfyDescriptionTemplate ?? defaultPushTemplates.descriptionTemplate };
      const ntfy = dependencies.config.ntfyTopic
        ? await sendPendingNotifications(dependencies.store, dependencies.ntfyPublisher ?? new NtfyPublisher(dependencies.config.ntfyTopic, dependencies.config.ntfyEndpoint), templates)
        : { sent: 0, failed: 0 };
      const exclusions = dependencies.groupedPipelineUserIds === '*'
        ? { excludeAllUsers: true as const }
        : { excludeUserIds: dependencies.groupedPipelineUserIds };
      const notifications = await sendNewJobNotifications(
        poll.newJobs.filter((job) => job.technical !== false), dependencies.userStore, publisher,
        undefined, undefined, exclusions,
      );
      const receipts = await inspectExpoPushReceipts(dependencies.userStore, publisher);
      const pushRetries = await retryExpoPushNotifications(
        dependencies.store, dependencies.userStore, publisher, undefined, exclusions,
      );
      return { poll, notifications, ntfy, receipts, pushRetries };
    }
    if (dependencies.notificationPublisher) {
      return { poll, notifications: await sendPendingNotifications(dependencies.store, dependencies.notificationPublisher) };
    }
    return { poll, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  if (!dependencies.emailSender) throw new Error('Digest delivery requires an email sender');
  return { digested: await sendDigest(dependencies.store, dependencies.emailSender) };
}
