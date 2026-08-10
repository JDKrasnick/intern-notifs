import { SendMessageBatchCommand, SQSClient, type SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from './sources/greenhouse-config.js';
import { DynamoInternshipStore } from './store.js';
import { isProviderSourceDue, SOURCE_POLL_CADENCE } from './source-poll-cadence.js';
import type { SourceCheckpoint, SourceHealth } from './types.js';

export const GREENHOUSE_DISPATCH_BATCH_SIZE = 10;
export const GREENHOUSE_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.activeIntervalMs;
export const GREENHOUSE_INACTIVE_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.quietIntervalMs;

export interface GreenhouseWorkMessage {
  version: 1;
  sourceId: string;
  scheduledAt: string;
  /** An operator replay may deliberately bypass a pause or provider backoff. */
  force?: boolean;
}

interface GreenhouseQueueClient {
  send(command: SendMessageBatchCommand): Promise<{ Failed?: Array<{ Id?: string; Message?: string }> }>;
}

interface CheckpointReader {
  getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined>;
  getSourceHealth?(sourceId: string): Promise<SourceHealth | undefined>;
}

export interface GreenhouseDispatchDependencies {
  queueUrl: string;
  client?: GreenhouseQueueClient;
  checkpointReader?: CheckpointReader;
  sources?: ReviewedGreenhouseSource[];
  now?: () => Date;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function greenhouseWorkMessages(
  sources: ReviewedGreenhouseSource[] = reviewedGreenhouseSources,
  scheduledAt = new Date(),
): GreenhouseWorkMessage[] {
  const timestamp = scheduledAt.toISOString();
  return sources.map((source) => ({ version: 1, sourceId: source.id, scheduledAt: timestamp }));
}

export function isGreenhouseSourceDue(
  source: ReviewedGreenhouseSource,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  return isProviderSourceDue(source.id, checkpoint, now, health);
}

async function dueSources(
  sources: ReviewedGreenhouseSource[],
  checkpointReader: CheckpointReader | undefined,
  now: Date,
): Promise<ReviewedGreenhouseSource[]> {
  if (!checkpointReader) return sources;
  const checkpoints = new Map<string, SourceCheckpoint | undefined>();
  const health = new Map<string, SourceHealth | undefined>();
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const source = sources[next++];
      const checkpointId = source.status === 'shadow' ? `shadow-${source.id}` : source.id;
      const [checkpoint, sourceHealth] = await Promise.all([
        checkpointReader.getCheckpoint(checkpointId),
        checkpointReader.getSourceHealth?.(source.id),
      ]);
      checkpoints.set(source.id, checkpoint);
      health.set(source.id, sourceHealth);
    }
  };
  await Promise.all(Array.from({ length: Math.min(24, sources.length) }, worker));
  return sources.filter((source) => isGreenhouseSourceDue(source, checkpoints.get(source.id), now, health.get(source.id)));
}

export async function dispatchGreenhouseBoards(dependencies: GreenhouseDispatchDependencies): Promise<{ queued: number }> {
  const client = dependencies.client ?? new SQSClient({});
  const now = (dependencies.now ?? (() => new Date()))();
  const sources = dependencies.sources ?? reviewedGreenhouseSources;
  const messages = greenhouseWorkMessages(await dueSources(sources, dependencies.checkpointReader, now), now);
  const window = Math.floor(now.getTime() / GREENHOUSE_POLL_INTERVAL_MS);
  let queued = 0;

  for (const [batchIndex, batch] of chunks(messages, GREENHOUSE_DISPATCH_BATCH_SIZE).entries()) {
    const entries: SendMessageBatchRequestEntry[] = batch.map((message, entryIndex) => ({
      Id: `${batchIndex}-${entryIndex}`,
      MessageBody: JSON.stringify(message),
      MessageGroupId: message.sourceId,
      MessageDeduplicationId: `${message.sourceId}:${window}`,
    }));
    const response = await client.send(new SendMessageBatchCommand({ QueueUrl: dependencies.queueUrl, Entries: entries }));
    if (response.Failed?.length) {
      const detail = response.Failed.map((failure) => `${failure.Id ?? 'unknown'}: ${failure.Message ?? 'unknown error'}`).join('; ');
      throw new Error(`Failed to queue Greenhouse boards: ${detail}`);
    }
    queued += entries.length;
  }
  return { queued };
}

export async function handler(): Promise<{ queued: number }> {
  const queueUrl = process.env.GREENHOUSE_QUEUE_URL;
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!queueUrl || !tableName) throw new Error('GREENHOUSE_QUEUE_URL and INTERNSHIPS_TABLE are required');
  const result = await dispatchGreenhouseBoards({ queueUrl, checkpointReader: new DynamoInternshipStore(tableName) });
  console.log(JSON.stringify({ command: 'greenhouse-dispatch', ...result }));
  return result;
}
