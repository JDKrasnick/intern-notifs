import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { dispatchGreenhouseBoards, GREENHOUSE_POLL_INTERVAL_MS, greenhouseWorkMessages, isGreenhouseSourceDue, type GreenhouseWorkMessage } from '../src/greenhouse-dispatch.js';
import { processGreenhouseQueue, runGreenhouseBoard } from '../src/greenhouse-worker.js';
import { MemoryInternshipStore } from '../src/store.js';
import { acmeJobsResponse, acmeSource, technicalInternship } from './fixtures/greenhouse.js';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from '../src/sources/greenhouse-config.js';

const scheduledAt = '2026-07-29T12:00:00.000Z';
const message = (sourceId = acmeSource.id): GreenhouseWorkMessage => ({ version: 1, sourceId, scheduledAt });
const response = (jobs = acmeJobsResponse) => new Response(JSON.stringify(jobs), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ETag: '"fixture"' },
});

describe('Greenhouse queue dispatch', () => {
  it('creates one versioned work item per reviewed board', () => {
    expect(greenhouseWorkMessages([acmeSource], new Date(scheduledAt))).toEqual([message()]);
    expect(greenhouseWorkMessages()).toHaveLength(166);
    expect(greenhouseWorkMessages().map((item) => item.sourceId)).toEqual(
      reviewedGreenhouseSources.map((source) => source.id),
    );
  });

  it('queues FIFO work in API-sized batches with per-board ordering and window deduplication', async () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      ...acmeSource,
      id: `greenhouse-board-${index}`,
      boardToken: `board-${index}`,
    }));
    const commands: SendMessageBatchCommand[] = [];
    const result = await dispatchGreenhouseBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/greenhouse.fifo',
      sources,
      now: () => new Date(scheduledAt),
      client: { async send(command) { commands.push(command); return {}; } },
    });

    expect(result).toEqual({ queued: 12 });
    expect(commands).toHaveLength(2);
    expect(commands[0].input.Entries).toHaveLength(10);
    expect(commands[1].input.Entries).toHaveLength(2);
    expect(commands[0].input.Entries?.[0]).toMatchObject({
      MessageGroupId: 'greenhouse-board-0',
      MessageDeduplicationId: expect.stringMatching(/^greenhouse-board-0:\d+$/),
    });
  });

  it('fails the dispatch when SQS rejects any board', async () => {
    await expect(dispatchGreenhouseBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/greenhouse.fifo',
      sources: [acmeSource],
      client: { async send() { return { Failed: [{ Id: '0-0', Message: 'throttled' }] }; } },
    })).rejects.toThrow('throttled');
  });

  it('automatically reduces a zero-eligible board to one staggered check per six hours', () => {
    const checkpoint = { sourceId: `shadow-${acmeSource.id}`, successfulFetches: 1, lastRowCount: 0 };
    const windows = Array.from({ length: 36 }, (_, index) => new Date(index * GREENHOUSE_POLL_INTERVAL_MS));
    expect(windows.filter((now) => isGreenhouseSourceDue(acmeSource, checkpoint, now))).toHaveLength(1);
    expect(isGreenhouseSourceDue(acmeSource, { ...checkpoint, lastRowCount: 1 }, windows[0])).toBe(true);
  });
});

describe('Greenhouse queue worker', () => {
  it('checks a shadow board without publishing jobs and stores an isolated checkpoint', async () => {
    const store = new MemoryInternshipStore();
    const result = await runGreenhouseBoard(message(), {
      store,
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toMatchObject({ sourceId: acmeSource.id, mode: 'shadow', listings: 1 });
    expect(store.jobs.size).toBe(0);
    expect(await store.getCheckpoint(`shadow-${acmeSource.id}`)).toMatchObject({
      sourceId: `shadow-${acmeSource.id}`,
      successfulFetches: 1,
      lastRowCount: 1,
    });
    expect(await store.getCheckpoint(acmeSource.id)).toBeUndefined();
  });

  it('quietly baselines a published board and makes only later roles notification-eligible', async () => {
    const published: ReviewedGreenhouseSource = { ...acmeSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let current = acmeJobsResponse;
    const dependencies = {
      store,
      sources: [published],
      fetchImpl: async () => response(current),
      linkValidator: async (url: string) => url,
    };
    await runGreenhouseBoard(message(), dependencies);
    expect(await store.pendingSms()).toEqual([]);

    current = {
      jobs: [
        ...(acmeJobsResponse.jobs ?? []),
        {
          ...technicalInternship,
          id: 6001,
          internal_job_id: 9601,
          title: 'Machine Learning Engineering Intern, Summer 2027',
          absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/6001',
        },
      ],
    };
    const result = await runGreenhouseBoard(message(), dependencies);

    expect(result).toMatchObject({ mode: 'published', listings: 2 });
    expect(await store.pendingSms()).toHaveLength(1);
  });

  it('returns only failed SQS record IDs for bounded retry', async () => {
    const store = new MemoryInternshipStore();
    const result = await processGreenhouseQueue({
      Records: [
        { messageId: 'good', body: JSON.stringify(message()) },
        { messageId: 'bad', body: JSON.stringify(message('greenhouse-unknown')) },
      ],
    }, {
      store,
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
    expect((await store.getSourceHealth(acmeSource.id))?.state).toBe('healthy');
    expect((await store.getSourceHealth('greenhouse-unknown'))?.state).toBe('degraded');
  });

  it('does not process later FIFO records from a board whose earlier record failed', async () => {
    const result = await processGreenhouseQueue({
      Records: [
        { messageId: 'bad', body: JSON.stringify(message('greenhouse-unknown')), attributes: { MessageGroupId: 'same-board' } },
        { messageId: 'blocked', body: JSON.stringify(message()), attributes: { MessageGroupId: 'same-board' } },
      ],
    }, {
      store: new MemoryInternshipStore(),
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'blocked' }] });
  });
});
