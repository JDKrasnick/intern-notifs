import { createSourceUrlValidator, type ApplicationUrlValidator } from './core/application-url.js';
import { ExpoPushPublisher, sendNewJobNotifications } from './notifications.js';
import { Poller } from './poll.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { LeverPostingsAdapter } from './sources/lever.js';
import { qualityPolicyFor, verifySourceQuality } from './sources/quality.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import type { LeverWorkMessage } from './lever-dispatch.js';

const SHADOW_CHECKPOINT_PREFIX = 'shadow-';
const SHADOW_LINK_CONCURRENCY = 4;
const SHADOW_LINK_FAILURE_THRESHOLD = 0.2;

interface QueueRecord {
  messageId: string;
  body: string;
  attributes?: { MessageGroupId?: string };
}

interface QueueEvent {
  Records: QueueRecord[];
}

export interface LeverBoardDependencies {
  store: InternshipStore;
  userStore?: UserStore;
  publisher?: ExpoPushPublisher;
  sources?: ReviewedLeverSource[];
  fetchImpl?: typeof fetch;
  linkValidator?: ApplicationUrlValidator;
}

export interface LeverBoardResult {
  sourceId: string;
  mode: 'shadow' | 'published';
  notModified: boolean;
  listings: number;
  notifications: { sent: number; skipped: number; failed: number };
}

function parseWorkMessage(body: string): LeverWorkMessage {
  const parsed = JSON.parse(body) as Partial<LeverWorkMessage>;
  if (parsed.version !== 1 || typeof parsed.sourceId !== 'string' || typeof parsed.scheduledAt !== 'string') {
    throw new Error('Invalid Lever work message');
  }
  if (!Number.isFinite(Date.parse(parsed.scheduledAt))) throw new Error('Invalid Lever work message timestamp');
  return parsed as LeverWorkMessage;
}

function validatorFor(fetchImpl?: typeof fetch): ApplicationUrlValidator {
  const policy = { allowedInitialHosts: ['jobs.lever.co'], allowedFinalHosts: ['jobs.lever.co'] };
  return fetchImpl ? createSourceUrlValidator(policy, fetchImpl) : createSourceUrlValidator(policy);
}

async function validateShadowLinks(
  listings: Awaited<ReturnType<LeverPostingsAdapter['fetch']>>['listings'],
  validate: ApplicationUrlValidator,
) {
  let next = 0;
  let failures = 0;
  const worker = async () => {
    while (next < listings.length) {
      const listing = listings[next++];
      try {
        await validate(listing.applyUrl);
      } catch {
        failures += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHADOW_LINK_CONCURRENCY, listings.length) }, worker));
  if (listings.length && failures / listings.length > SHADOW_LINK_FAILURE_THRESHOLD) {
    throw new Error(`${failures}/${listings.length} eligible Lever application links failed shadow validation`);
  }
}

export async function runLeverBoard(
  message: LeverWorkMessage,
  dependencies: LeverBoardDependencies,
): Promise<LeverBoardResult> {
  const registry = dependencies.sources ?? reviewedLeverSources;
  const source = registry.find((candidate) => candidate.id === message.sourceId);
  if (!source) throw new Error(`Unknown reviewed Lever source ${JSON.stringify(message.sourceId)}`);
  const mode = source.status;
  const checkpointId = mode === 'shadow' ? `${SHADOW_CHECKPOINT_PREFIX}${source.id}` : source.id;
  const adapter = new LeverPostingsAdapter({
    id: source.id,
    company: source.company,
    site: source.site,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const validate = dependencies.linkValidator ?? validatorFor(dependencies.fetchImpl);

  if (mode === 'shadow') {
    const previous = await dependencies.store.getCheckpoint(checkpointId);
    const result = await adapter.fetch(previous);
    if (!result.notModified) {
      const quality = verifySourceQuality([{ policy: qualityPolicyFor(source.id), result, previous }]);
      if (quality.failures.length) throw new Error(quality.failures.join('; '));
      await validateShadowLinks(result.listings, validate);
    }
    await dependencies.store.putCheckpoint({ ...result.checkpoint, sourceId: checkpointId });
    return {
      sourceId: source.id,
      mode,
      notModified: result.notModified,
      listings: result.notModified ? previous?.lastRowCount ?? 0 : result.listings.length,
      notifications: { sent: 0, skipped: 0, failed: 0 },
    };
  }

  const poll = await new Poller([adapter], dependencies.store, undefined, undefined, validate).poll();
  if (poll.failures.length) throw new Error(poll.failures.join('; '));
  const notifications = dependencies.userStore
    ? await sendNewJobNotifications(
      poll.newJobs.filter((job) => job.technical !== false),
      dependencies.userStore,
      dependencies.publisher ?? new ExpoPushPublisher(),
    )
    : { sent: 0, skipped: 0, failed: 0 };
  return {
    sourceId: source.id,
    mode,
    notModified: poll.unchangedSources.includes(adapter.id),
    listings: poll.processedListings,
    notifications,
  };
}

export async function processLeverQueue(
  event: QueueEvent,
  dependencies: LeverBoardDependencies,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  const blockedGroups = new Set<string>();
  for (const record of event.Records) {
    const groupId = record.attributes?.MessageGroupId;
    if (groupId && blockedGroups.has(groupId)) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const result = await runLeverBoard(parseWorkMessage(record.body), dependencies);
      console.log(JSON.stringify({ command: 'lever-poll', ...result }));
    } catch (error) {
      console.error(JSON.stringify({
        command: 'lever-poll',
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
      if (groupId) blockedGroups.add(groupId);
    }
  }
  return { batchItemFailures };
}

export async function handler(event: QueueEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const tableName = process.env.INTERNSHIPS_TABLE;
  const usersTable = process.env.USERS_TABLE;
  if (!tableName || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  return processLeverQueue(event, {
    store: new DynamoInternshipStore(tableName),
    userStore: new DynamoUserStore(usersTable),
  });
}
