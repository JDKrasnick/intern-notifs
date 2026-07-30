import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { dispatchLeverBoards, LEVER_POLL_INTERVAL_MS, isLeverSourceDue, leverWorkMessages, type LeverWorkMessage } from '../src/lever-dispatch.js';
import { processLeverQueue, runLeverBoard } from '../src/lever-worker.js';
import { reviewedLeverSources, type ReviewedLeverSource } from '../src/sources/lever-config.js';
import { MemoryInternshipStore } from '../src/store.js';

const scheduledAt = '2026-07-30T12:00:00.000Z';
const shadowSource = reviewedLeverSources.find((source) => source.status === 'shadow')!;
const message = (sourceId = shadowSource.id): LeverWorkMessage => ({ version: 1, sourceId, scheduledAt });
const posting = {
  id: 'job-1',
  text: 'Software Engineering Intern, Summer 2027',
  applyUrl: `https://jobs.lever.co/${shadowSource.site}/job-1/apply`,
  hostedUrl: `https://jobs.lever.co/${shadowSource.site}/job-1`,
  descriptionPlain: 'Build reliable software.',
  categories: { location: 'Remote', commitment: 'Internship' },
};
const response = (postings = [posting]) => new Response(JSON.stringify(postings), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ETag: '"fixture"' },
});

describe('Lever queue dispatch', () => {
  it('creates one versioned work item per reviewed board', () => {
    expect(leverWorkMessages([shadowSource], new Date(scheduledAt))).toEqual([message()]);
    expect(leverWorkMessages()).toHaveLength(reviewedLeverSources.length);
    expect(leverWorkMessages().map((item) => item.sourceId)).toEqual(
      reviewedLeverSources.map((source) => source.id),
    );
  });

  it('queues FIFO work with per-board ordering and window deduplication', async () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      ...shadowSource,
      id: `lever-board-${index}`,
      site: `board-${index}`,
    }));
    const commands: SendMessageBatchCommand[] = [];
    const result = await dispatchLeverBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/lever.fifo',
      sources,
      now: () => new Date(scheduledAt),
      client: { async send(command) { commands.push(command); return {}; } },
    });

    expect(result).toEqual({ queued: 12 });
    expect(commands).toHaveLength(2);
    expect(commands[0].input.Entries).toHaveLength(10);
    expect(commands[1].input.Entries).toHaveLength(2);
    expect(commands[0].input.Entries?.[0]).toMatchObject({
      MessageGroupId: 'lever-board-0',
      MessageDeduplicationId: expect.stringMatching(/^lever-board-0:\d+$/),
    });
  });

  it('automatically reduces an empty board to one staggered check per six hours', () => {
    const checkpoint = { sourceId: `shadow-${shadowSource.id}`, successfulFetches: 1, lastRowCount: 0 };
    const windows = Array.from({ length: 36 }, (_, index) => new Date(index * LEVER_POLL_INTERVAL_MS));
    expect(windows.filter((now) => isLeverSourceDue(shadowSource, checkpoint, now))).toHaveLength(1);
    expect(isLeverSourceDue(shadowSource, { ...checkpoint, lastRowCount: 1 }, windows[0])).toBe(true);
  });
});

describe('Lever queue worker', () => {
  it('checks a shadow board without publishing jobs and stores an isolated checkpoint', async () => {
    const store = new MemoryInternshipStore();
    const result = await runLeverBoard(message(), {
      store,
      sources: [shadowSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toMatchObject({ sourceId: shadowSource.id, mode: 'shadow', listings: 1 });
    expect(store.jobs.size).toBe(0);
    expect(await store.getCheckpoint(`shadow-${shadowSource.id}`)).toMatchObject({
      sourceId: `shadow-${shadowSource.id}`,
      successfulFetches: 1,
      lastRowCount: 1,
    });
    expect(await store.getCheckpoint(shadowSource.id)).toBeUndefined();
  });

  it('quietly baselines a published board and makes only later roles notification-eligible', async () => {
    const published: ReviewedLeverSource = { ...shadowSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let current = [posting];
    const dependencies = {
      store,
      sources: [published],
      fetchImpl: async () => response(current),
      linkValidator: async (url: string) => url,
    };
    await runLeverBoard(message(), dependencies);
    expect(await store.pendingSms()).toEqual([]);

    current = [
      posting,
      {
        ...posting,
        id: 'job-2',
        text: 'Machine Learning Engineering Intern, Summer 2027',
        hostedUrl: `https://jobs.lever.co/${shadowSource.site}/job-2`,
        applyUrl: `https://jobs.lever.co/${shadowSource.site}/job-2/apply`,
      },
    ];
    const result = await runLeverBoard(message(), dependencies);

    expect(result).toMatchObject({ mode: 'published', listings: 2 });
    expect(await store.pendingSms()).toHaveLength(1);
  });

  it('returns only failed SQS records and blocks later work in the same FIFO group', async () => {
    const result = await processLeverQueue({
      Records: [
        { messageId: 'bad', body: JSON.stringify(message('lever-unknown')), attributes: { MessageGroupId: 'same-board' } },
        { messageId: 'blocked', body: JSON.stringify(message()), attributes: { MessageGroupId: 'same-board' } },
      ],
    }, {
      store: new MemoryInternshipStore(),
      sources: [shadowSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'blocked' }] });
  });
});
