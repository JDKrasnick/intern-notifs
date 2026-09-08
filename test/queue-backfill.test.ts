import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { backfilledQueueMembership, needsQueueBackfill, QUEUE_BACKFILL_D1_SQL } from '../src/queue-backfill.js';
import type { ApplicationRecord } from '../src/types.js';

const saved = (overrides: Partial<ApplicationRecord> = {}): ApplicationRecord => ({
  applicationId: 'app-1', jobId: 'job-1', status: 'saved',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
});

describe('queue backfill', () => {
  it('adopts legacy saved records without touching queued or advanced ones', () => {
    expect(needsQueueBackfill(saved())).toBe(true);
    expect(needsQueueBackfill(saved({ queuedAt: '2026-09-01T00:00:00.000Z' }))).toBe(false);
    expect(needsQueueBackfill(saved({ status: 'applied' }))).toBe(false);
    expect(backfilledQueueMembership(saved())).toMatchObject({ status: 'saved', queuedAt: '2026-09-01T00:00:00.000Z' });
  });

  it('applies the D1 statement to exactly the legacy saved rows', () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE user_items (user_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, item_key))`);
    const insert = sqlite.prepare('INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, ?, ?)');
    insert.run('u', 'APPLICATION#a', 'application', JSON.stringify(saved({ applicationId: 'a' })));
    insert.run('u', 'APPLICATION#b', 'application', JSON.stringify(saved({ applicationId: 'b', queuedAt: '2026-09-01T00:00:00.000Z' })));
    insert.run('u', 'APPLICATION#c', 'application', JSON.stringify(saved({ applicationId: 'c', status: 'applied' })));
    const changes = sqlite.prepare(QUEUE_BACKFILL_D1_SQL).run().changes;
    expect(Number(changes)).toBe(1);
    const rows = sqlite.prepare('SELECT value FROM user_items').all().map((row) => JSON.parse((row as { value: string }).value));
    expect(rows).toMatchObject([
      { applicationId: 'a', queuedAt: '2026-09-01T00:00:00.000Z' },
      { applicationId: 'b', queuedAt: '2026-09-01T00:00:00.000Z' },
      { applicationId: 'c' },
    ]);
    expect(rows[2]).not.toHaveProperty('queuedAt');
    sqlite.close();
  });
});
