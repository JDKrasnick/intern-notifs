export interface FifoQueueRecord {
  messageId: string;
  attributes?: { MessageGroupId?: string };
}

export interface FifoBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

export type FifoRecordFailureHook<Record extends FifoQueueRecord> = (record: Record, error: unknown) => Promise<void> | void;

const DEFAULT_GROUP_CONCURRENCY = 4;

/**
 * Process independent FIFO message groups concurrently while preserving strict
 * ordering and failure isolation within each group.
 *
 * `onRecordFailure` observes the record that actually threw (not the records it
 * blocks) so callers can persist a per-message failure diagnostic before the
 * platform retries and eventually dead-letters it. A throwing hook is contained
 * so it can never break failure isolation.
 */
export async function processFifoBatch<Record extends FifoQueueRecord>(
  records: readonly Record[],
  processRecord: (record: Record) => Promise<void>,
  groupConcurrency = DEFAULT_GROUP_CONCURRENCY,
  onRecordFailure?: FifoRecordFailureHook<Record>,
): Promise<FifoBatchResponse> {
  if (!Number.isInteger(groupConcurrency) || groupConcurrency < 1) {
    throw new RangeError('FIFO group concurrency must be a positive integer');
  }

  const groups = new Map<string, Record[]>();
  records.forEach((record, index) => {
    // A missing group ID should not cause unrelated malformed/test records to
    // block one another. Production FIFO records always include this attribute.
    const groupId = record.attributes?.MessageGroupId ?? `__ungrouped__${index}`;
    const group = groups.get(groupId);
    if (group) group.push(record);
    else groups.set(groupId, [record]);
  });

  const pendingGroups = [...groups.values()];
  const failedIds = new Set<string>();
  let nextGroup = 0;
  const worker = async () => {
    while (nextGroup < pendingGroups.length) {
      const group = pendingGroups[nextGroup++];
      for (let index = 0; index < group.length; index += 1) {
        const record = group[index]!;
        try {
          await processRecord(record);
        } catch (error) {
          for (const blocked of group.slice(index)) failedIds.add(blocked.messageId);
          if (onRecordFailure) {
            try {
              await onRecordFailure(record, error);
            } catch { /* Diagnostics must never break failure isolation. */ }
          }
          break;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(groupConcurrency, pendingGroups.length) }, worker));
  return {
    batchItemFailures: records
      .filter((record) => failedIds.has(record.messageId))
      .map((record) => ({ itemIdentifier: record.messageId })),
  };
}
