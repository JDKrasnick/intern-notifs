import { describe, expect, it, vi } from 'vitest';
import { processFifoBatch } from '../src/sqs-fifo-batch.js';

const record = (messageId: string, groupId: string) => ({
  messageId,
  attributes: { MessageGroupId: groupId },
});

describe('FIFO batch processing', () => {
  it('processes independent message groups concurrently', async () => {
    const started: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const processing = processFifoBatch([
      record('board-a', 'a'),
      record('board-b', 'b'),
    ], async (item) => {
      started.push(item.messageId);
      await gate;
    });

    await vi.waitFor(() => expect(started).toEqual(['board-a', 'board-b']));
    release();
    await expect(processing).resolves.toEqual({ batchItemFailures: [] });
  });

  it('processes records from the same group sequentially', async () => {
    const started: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const processing = processFifoBatch([
      record('first', 'same'),
      record('second', 'same'),
    ], async (item) => {
      started.push(item.messageId);
      if (item.messageId === 'first') await gate;
    });

    await vi.waitFor(() => expect(started).toEqual(['first']));
    release();
    await expect(processing).resolves.toEqual({ batchItemFailures: [] });
    expect(started).toEqual(['first', 'second']);
  });

  it('blocks the remainder of a failed group without blocking other groups', async () => {
    const processed: string[] = [];
    const result = await processFifoBatch([
      record('failed', 'a'),
      record('other', 'b'),
      record('blocked', 'a'),
    ], async (item) => {
      processed.push(item.messageId);
      if (item.messageId === 'failed') throw new Error('provider failed');
    });

    expect(processed).toEqual(['failed', 'other']);
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'failed' }, { itemIdentifier: 'blocked' }],
    });
  });

  it('reports the throwing record to onRecordFailure but not the records it blocks', async () => {
    const cause = new Error('provider failed');
    const observed: Array<{ messageId: string; error: unknown }> = [];
    const result = await processFifoBatch([
      record('failed', 'a'),
      record('blocked', 'a'),
      record('other', 'b'),
    ], async (item) => {
      if (item.messageId === 'failed') throw cause;
    }, undefined, (item, error) => { observed.push({ messageId: item.messageId, error }); });

    expect(observed).toEqual([{ messageId: 'failed', error: cause }]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'failed' }, { itemIdentifier: 'blocked' }]);
  });

  it('contains a throwing onRecordFailure hook so failure isolation is preserved', async () => {
    const result = await processFifoBatch([
      record('failed', 'a'),
      record('other', 'b'),
    ], async (item) => {
      if (item.messageId === 'failed') throw new Error('provider failed');
    }, undefined, () => { throw new Error('ledger unavailable'); });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'failed' }]);
  });
});
