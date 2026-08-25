import { describe, expect, it, vi } from 'vitest';
import { queueHasBacklog } from '../cloudflare/queue-backlog.js';
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
