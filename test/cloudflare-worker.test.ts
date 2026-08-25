import { describe, expect, it, vi } from 'vitest';
import { queueHasBacklog } from '../cloudflare/queue-backlog.js';
import { cloudflareOperationsQueueClient, readDocumentUpload } from '../cloudflare/worker.js';
import type { Queue } from '../cloudflare/types.js';

const queue = (metrics: Queue['metrics']): Queue => ({
  async send() {},
  async sendBatch() {},
  metrics,
});

describe('Cloudflare scheduled dispatch cost guard', () => {
  it('skips a new polling cycle while prior messages remain queued', async () => {
    await expect(queueHasBacklog(queue(async () => ({ backlogCount: 12, backlogBytes: 1024 })), 'greenhouse')).resolves.toBe(true);
  });

  it('allows a polling cycle when the queue is empty', async () => {
    await expect(queueHasBacklog(queue(async () => ({ backlogCount: 0, backlogBytes: 0 })), 'github')).resolves.toBe(false);
  });

  it('fails open when best-effort queue metrics are unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(queueHasBacklog(queue(async () => { throw new Error('metrics unavailable'); }), 'greenhouse')).resolves.toBe(false);
    vi.restoreAllMocks();
  });
});

describe('Cloudflare operations queue adapter', () => {
  it('reports live work-queue and dead-letter-queue backlogs', async () => {
    const client = cloudflareOperationsQueueClient({
      GREENHOUSE_QUEUE: queue(async () => ({ backlogCount: 7, backlogBytes: 700 })),
      LEVER_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ASHBY_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      GREENHOUSE_DLQ: queue(async () => ({ backlogCount: 2, backlogBytes: 200 })),
      LEVER_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ASHBY_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
    });

    await expect(client.send({ input: { QueueUrl: 'greenhouse' } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '7' },
    });
    await expect(client.send({ input: { QueueUrl: 'greenhouse' } })).resolves.not.toMatchObject({
      Attributes: { ApproximateNumberOfMessagesNotVisible: expect.anything() },
    });
    await expect(client.send({ input: { QueueUrl: 'greenhouse-dlq' } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '2' },
    });
  });
});

describe('Cloudflare document upload bounds', () => {
  it('rejects an oversized declared body without reading its stream', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request('https://example.test/me/documents/document-1/content', {
      method: 'PUT',
      headers: { 'Content-Length': String(5 * 1024 * 1024 + 1) },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readDocumentUpload(request)).resolves.toEqual({ tooLarge: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an undeclared body as soon as streamed bytes cross the limit', async () => {
    const cancel = vi.fn();
    const chunks = [new Uint8Array(5 * 1024 * 1024), new Uint8Array(1)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    const request = new Request('https://example.test/me/documents/document-1/content', {
      method: 'PUT',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readDocumentUpload(request)).resolves.toEqual({ tooLarge: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns a body at the exact 5 MiB boundary', async () => {
    const request = new Request('https://example.test/me/documents/document-1/content', {
      method: 'PUT',
      body: new Uint8Array(5 * 1024 * 1024),
    });

    const result = await readDocumentUpload(request);
    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) expect(result.content.byteLength).toBe(5 * 1024 * 1024);
  });
});
