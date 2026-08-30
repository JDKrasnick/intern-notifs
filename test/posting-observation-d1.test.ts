import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import type { Internship, PostingIdentityDecision, SourceOccurrenceState } from '../src/types.js';

function sqliteD1(database: DatabaseSync, failBatchAfter?: number): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          if (failBatchAfter !== undefined && index === failBatchAfter) throw new Error('injected observation failure');
          results.push(await statements[index]!.run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function subject(failBatchAfter?: number) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0010_posting_identity.sql', import.meta.url), 'utf8'));
  return { sqlite, store: new D1InternshipStore(sqliteD1(sqlite, failBatchAfter)) };
}

function input() {
  const observedAt = '2026-08-29T12:00:00.000Z';
  const identity = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  const decision: Exclude<PostingIdentityDecision, { status: 'quarantined' }> = {
    status: 'confirmed', exactKey: `provider:ashby:acme:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    evidenceKind: 'immutable-provider-id', provider: 'ashby', tenant: 'acme', contractId: 'posting-provider-ashby',
    contractVersion: 1, approvalReference: 'registry:ashby:v1', evidenceHash: 'hash', observedAt,
  };
  const source = {
    sourceId: 'community', externalId: 'role-a', document: 'README', sourceUrl: 'https://source.example.test', row: 1,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: identity.canonicalApplicationUrl, compensation: { raw: '' }, state: 'open' as const,
    postingIdentityDecision: decision,
  };
  const job: Internship = {
    jobId: identity.canonicalJobId, company: source.company, title: source.title, location: source.location, season: source.season,
    applyUrl: source.applyUrl, normalizedUrl: source.applyUrl, fingerprint: 'fingerprint', compensation: source.compensation,
    sourceReferences: [source], postingIdentity: identity, postingIdentityStatus: 'confirmed', technical: true, open: true,
    firstSeenAt: observedAt, catalogVisibleAt: observedAt, lastSeenAt: observedAt, notification: { smsPending: true, digestPending: true },
  };
  const occurrence: SourceOccurrenceState = {
    sourceId: source.sourceId, externalId: source.externalId, jobId: job.jobId, occurrence: source,
    present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot', changedAt: observedAt,
  };
  return { decision, identity, job, occurrence, notificationEvent: {
    eventId: 'event-a', sourceId: source.sourceId, externalId: source.externalId, jobId: job.jobId,
    kind: 'new-job' as const, createdAt: observedAt,
  } };
}

describe('D1 atomic posting observation', () => {
  it('writes the complete observation in one D1 transaction', async () => {
    const { sqlite, store } = subject();
    await expect(store.commitPostingObservation(input())).resolves.toMatchObject({ outcome: 'committed', notificationInserted: true });
    expect(sqlite.prepare("SELECT kind, count(*) AS count FROM catalog_items GROUP BY kind ORDER BY kind").all()).toEqual(expect.arrayContaining([
      { kind: 'internship', count: 1 }, { kind: 'notification-event', count: 1 },
      { kind: 'source-occurrence', count: 1 },
    ]));
    expect(sqlite.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'posting-alias'").get()).toMatchObject({ count: expect.any(Number) });
  });

  it('rolls back every public write when a failure is injected mid-commit', async () => {
    const { sqlite, store } = subject(1);
    await expect(store.commitPostingObservation(input())).rejects.toThrow('injected observation failure');
    expect(sqlite.prepare('SELECT count(*) AS count FROM catalog_items').get()).toEqual({ count: 0 });
  });

  it('queues an identity-unconfirmed URL family without retaining URL values', async () => {
    const { sqlite, store } = subject();
    const original = input();
    const decision = {
      status: 'unconfirmed' as const,
      reason: 'unrecognized-url-family' as const,
      reviewFamilyKey: 'careers.example.test/jobs/:number?ref',
      observedAt: '2026-08-29T12:00:00.000Z',
    };
    await store.commitPostingObservation({
      decision,
      job: { ...original.job, postingIdentity: undefined, postingIdentityStatus: 'unconfirmed' },
      occurrence: {
        ...original.occurrence,
        occurrence: { ...original.occurrence.occurrence, postingIdentityDecision: decision },
      },
      notificationEvent: original.notificationEvent,
    });
    expect(sqlite.prepare('SELECT sanitized_signature, occurrence_count FROM posting_identity_review_candidates').get())
      .toEqual({ sanitized_signature: decision.reviewFamilyKey, occurrence_count: 1 });
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM posting_identity_review_candidates').all()))
      .not.toContain('utm_');
  });

  it('makes reviewer decisions immutable', () => {
    const { sqlite } = subject();
    sqlite.prepare("INSERT INTO posting_identity_review_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('candidate', 'family', 'family', 2, 'hash', '2026-08-01', '2026-08-02', 'approved');
    sqlite.prepare("INSERT INTO posting_identity_review_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('decision', 'candidate', 'approved', 'contract', 1, 'hash', 'reviewer', '2026-08-02');
    expect(() => sqlite.prepare("UPDATE posting_identity_review_decisions SET reviewed_by = 'other' WHERE id = 'decision'").run())
      .toThrow(/immutable/u);
  });
});
