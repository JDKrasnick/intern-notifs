import { SendMessageBatchCommand, SQSClient, type SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { DynamoInternshipStore, type LeverAdmission } from './store.js';
import type { SourceCheckpoint } from './types.js';

export const LEVER_DISPATCH_BATCH_SIZE = 10;
export const LEVER_POLL_INTERVAL_MS = 10 * 60 * 1000;
export const LEVER_INACTIVE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface LeverWorkMessage {
  version: 1;
  sourceId: string;
  scheduledAt: string;
}

interface LeverQueueClient {
  send(command: SendMessageBatchCommand): Promise<{ Failed?: Array<{ Id?: string; Message?: string }> }>;
}

interface CheckpointReader {
  getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined>;
  listLeverAdmissions?(): Promise<LeverAdmission[]>;
}

export interface LeverDispatchDependencies {
  queueUrl: string;
  client?: LeverQueueClient;
  checkpointReader?: CheckpointReader;
  sources?: ReviewedLeverSource[];
  now?: () => Date;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function leverWorkMessages(
  sources: ReviewedLeverSource[] = reviewedLeverSources,
  scheduledAt = new Date(),
): LeverWorkMessage[] {
  const timestamp = scheduledAt.toISOString();
  return sources.map((source) => ({ version: 1, sourceId: source.id, scheduledAt: timestamp }));
}

function stableBoardBucket(sourceId: string, buckets: number): number {
  let hash = 2166136261;
  for (const character of sourceId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % buckets;
}

export function isLeverSourceDue(
  source: ReviewedLeverSource,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
): boolean {
  if (!checkpoint || (checkpoint.lastRowCount ?? 0) > 0) return true;
  const buckets = LEVER_INACTIVE_POLL_INTERVAL_MS / LEVER_POLL_INTERVAL_MS;
  const currentWindow = Math.floor(now.getTime() / LEVER_POLL_INTERVAL_MS);
  return currentWindow % buckets === stableBoardBucket(source.id, buckets);
}

async function dueSources(
  sources: ReviewedLeverSource[],
  checkpointReader: CheckpointReader | undefined,
  now: Date,
): Promise<ReviewedLeverSource[]> {
  if (!checkpointReader) return sources;
  const checkpoints = new Map<string, SourceCheckpoint | undefined>();
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const source = sources[next++];
      const checkpointId = source.status === 'shadow' ? `shadow-${source.id}` : source.id;
      checkpoints.set(source.id, await checkpointReader.getCheckpoint(checkpointId));
    }
  };
  await Promise.all(Array.from({ length: Math.min(24, sources.length) }, worker));
  return sources.filter((source) => isLeverSourceDue(source, checkpoints.get(source.id), now));
}

export async function dispatchLeverBoards(dependencies: LeverDispatchDependencies): Promise<{ queued: number }> {
  const client = dependencies.client ?? new SQSClient({});
  const now = (dependencies.now ?? (() => new Date()))();
  const dynamic = dependencies.sources || !dependencies.checkpointReader?.listLeverAdmissions
    ? []
    : (await dependencies.checkpointReader.listLeverAdmissions()).map(({ source }) => source);
  const sources = dependencies.sources ?? [...reviewedLeverSources, ...dynamic];
  const messages = leverWorkMessages(await dueSources(sources, dependencies.checkpointReader, now), now);
  const window = Math.floor(now.getTime() / LEVER_POLL_INTERVAL_MS);
  let queued = 0;

  for (const [batchIndex, batch] of chunks(messages, LEVER_DISPATCH_BATCH_SIZE).entries()) {
    const entries: SendMessageBatchRequestEntry[] = batch.map((message, entryIndex) => ({
      Id: `${batchIndex}-${entryIndex}`,
      MessageBody: JSON.stringify(message),
      MessageGroupId: message.sourceId,
      MessageDeduplicationId: `${message.sourceId}:${window}`,
    }));
    const response = await client.send(new SendMessageBatchCommand({ QueueUrl: dependencies.queueUrl, Entries: entries }));
    if (response.Failed?.length) {
      const detail = response.Failed.map((failure) => `${failure.Id ?? 'unknown'}: ${failure.Message ?? 'unknown error'}`).join('; ');
      throw new Error(`Failed to queue Lever boards: ${detail}`);
    }
    queued += entries.length;
  }
  return { queued };
}

export async function handler(): Promise<{ queued: number }> {
  const queueUrl = process.env.LEVER_QUEUE_URL;
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!queueUrl || !tableName) throw new Error('LEVER_QUEUE_URL and INTERNSHIPS_TABLE are required');
  const result = await dispatchLeverBoards({ queueUrl, checkpointReader: new DynamoInternshipStore(tableName) });
  console.log(JSON.stringify({ command: 'lever-dispatch', ...result }));
  return result;
}
