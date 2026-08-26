import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query);
    const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return {
    prepare(query: string) { return prepared(query); },
    async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); },
  };
}

describe('D1 notification recovery', () => {
  it('previews with an exact candidate-set guard and never requeues a job that has a receipt', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (pk TEXT, sk TEXT, kind TEXT, value TEXT, catalog_state TEXT, sms_pending INTEGER, PRIMARY KEY (pk, sk));
      CREATE TABLE user_items (user_id TEXT, item_key TEXT, kind TEXT, value TEXT, PRIMARY KEY (user_id, item_key));
    `);
    const job = { jobId: 'job-1', notification: { smsPending: false, smsSentAt: '2026-08-25T12:10:00.000Z', digestPending: true } };
    const event = { eventId: 'event-1', sourceId: 'source', externalId: 'row-1', jobId: 'job-1', kind: 'new-job', createdAt: '2026-08-25T12:00:00.000Z' };
    database.prepare('INSERT INTO catalog_items VALUES (?, ?, ?, ?, ?, ?)').run('JOB#job-1', 'META', 'internship', JSON.stringify(job), 'OPEN', 0);
    database.prepare('INSERT INTO catalog_items VALUES (?, ?, ?, ?, ?, ?)').run('OUTBOX#event-1', 'EVENT', 'notification-event', JSON.stringify(event), null, 0);
    const store = new D1InternshipStore(sqliteD1(database));

    await expect(store.recoverUndeliveredNotifications({ since: '2026-08-25T00:00:00.000Z', limit: 100, apply: false }))
      .resolves.toEqual({ candidates: 1, candidateJobIds: ['job-1'], requeued: 0 });
    await expect(store.recoverUndeliveredNotifications({ since: '2026-08-25T00:00:00.000Z', limit: 100, apply: true, expectedCandidateJobIds: ['job-2'] }))
      .rejects.toThrow('candidate set changed');
    await expect(store.recoverUndeliveredNotifications({ since: '2026-08-25T00:00:00.000Z', limit: 100, apply: true, expectedCandidateJobIds: ['job-1'] }))
      .resolves.toEqual({ candidates: 1, candidateJobIds: ['job-1'], requeued: 1 });
    const recovered = database.prepare("SELECT value, sms_pending FROM catalog_items WHERE pk = 'JOB#job-1'").get() as { value: string; sms_pending: number };
    expect(recovered.sms_pending).toBe(1);
    expect(JSON.parse(recovered.value).notification).toEqual({ smsPending: true, digestPending: true });

    database.prepare('UPDATE catalog_items SET sms_pending = 0 WHERE pk = ?').run('JOB#job-1');
    database.prepare('INSERT INTO user_items VALUES (?, ?, ?, ?)').run('user-1', 'RECEIPT#job-1', 'receipt', JSON.stringify({ jobId: 'job-1' }));
    await expect(store.recoverUndeliveredNotifications({ since: '2026-08-25T00:00:00.000Z', limit: 100, apply: false }))
      .resolves.toEqual({ candidates: 0, candidateJobIds: [], requeued: 0 });
    database.close();
  });

  it('rejects apply when the candidate identity changes without changing the count', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (pk TEXT, sk TEXT, kind TEXT, value TEXT, catalog_state TEXT, sms_pending INTEGER, PRIMARY KEY (pk, sk));
      CREATE TABLE user_items (user_id TEXT, item_key TEXT, kind TEXT, value TEXT, PRIMARY KEY (user_id, item_key));
    `);
    const addCandidate = (jobId: string, createdAt: string) => {
      const job = { jobId, notification: { smsPending: false, digestPending: true } };
      const event = { eventId: `event-${jobId}`, sourceId: 'source', externalId: jobId, jobId, kind: 'new-job', createdAt };
      database.prepare('INSERT INTO catalog_items VALUES (?, ?, ?, ?, ?, ?)').run(`JOB#${jobId}`, 'META', 'internship', JSON.stringify(job), 'OPEN', 0);
      database.prepare('INSERT INTO catalog_items VALUES (?, ?, ?, ?, ?, ?)').run(`OUTBOX#${jobId}`, 'EVENT', 'notification-event', JSON.stringify(event), null, 0);
    };
    addCandidate('job-1', '2026-08-25T12:00:00.000Z');
    const store = new D1InternshipStore(sqliteD1(database));
    const preview = await store.recoverUndeliveredNotifications({ since: '2026-08-25T00:00:00.000Z', limit: 1, apply: false });
    expect(preview.candidateJobIds).toEqual(['job-1']);

    database.prepare('INSERT INTO user_items VALUES (?, ?, ?, ?)').run('user-1', 'RECEIPT#job-1', 'receipt', JSON.stringify({ jobId: 'job-1' }));
    addCandidate('job-2', '2026-08-25T13:00:00.000Z');

    await expect(store.recoverUndeliveredNotifications({
      since: '2026-08-25T00:00:00.000Z', limit: 1, apply: true, expectedCandidateJobIds: preview.candidateJobIds,
    })).rejects.toThrow('candidate set changed');
    expect((database.prepare("SELECT sms_pending FROM catalog_items WHERE pk = 'JOB#job-2'").get() as { sms_pending: number }).sms_pending).toBe(0);
    database.close();
  });
});
