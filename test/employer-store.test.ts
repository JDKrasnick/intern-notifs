import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1EmployerStore } from '../cloudflare/employer-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { EmployerAuditEvent, EmployerOrganization } from '../src/employer-types.js';

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
    async batch(statements: D1PreparedStatement[]) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(new URL('../cloudflare/migrations/0006_employer_channel.sql', import.meta.url), 'utf8'));
  return { database, store: new D1EmployerStore(sqliteD1(database)) };
}

const now = '2026-08-26T00:00:00.000Z';
const organization = (id: string, domain = `${id}.test`): EmployerOrganization => ({
  id, domain, name: id, state: 'active', createdAt: now, updatedAt: now,
});
const audit = (id: string, organizationId: string, action: string, key?: string): EmployerAuditEvent => ({
  id, organizationId, action, actorType: 'member', actorId: 'owner', subjectType: 'organization',
  subjectId: organizationId, createdAt: now, idempotencyKey: key,
});

describe('D1EmployerStore', () => {
  it('stores organization-scoped memberships and immutable, idempotent audit history', async () => {
    const { database, store } = fixture();
    await store.putOrganization(organization('one'), audit('event-create', 'one', 'organization.created', 'request-1'));
    await store.putOrganization(organization('two'));
    await store.putMembership({ organizationId: 'one', userId: 'user', role: 'owner', createdAt: now, updatedAt: now },
      audit('event-member', 'one', 'membership.added', 'request-2'));

    expect(await store.getMembership('one', 'user')).toMatchObject({ role: 'owner' });
    expect(await store.getMembership('two', 'user')).toBeUndefined();
    expect(await store.getOrganizationByDomain('ONE.TEST.')).toMatchObject({ id: 'one' });
    expect(await store.listAuditEvents('one')).toHaveLength(2);
    expect(await store.listAuditEvents('one')).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: expect.stringMatching(/^sha256:/u), idempotencyKey: expect.stringMatching(/^sha256:/u) }),
    ]));
    expect((await store.listAuditEvents('one')).some((event) => event.actorId === 'owner' || event.idempotencyKey === 'request-1')).toBe(false);
    expect(await store.appendAuditEvent(audit('event-replay', 'one', 'membership.added', 'request-2'))).toBe(false);
    expect(await store.listAuditEvents('one')).toHaveLength(2);
    expect(() => database.prepare("UPDATE employer_audit_events SET action = 'changed'").run()).toThrow(/immutable/u);
    expect(() => database.prepare('DELETE FROM employer_audit_events').run()).toThrow(/immutable/u);

    expect(await store.claimIdempotency('one', 'invite', 'same-key', now, { id: 'inv-1' })).toBe(true);
    expect(await store.claimIdempotency('one', 'invite', 'same-key', now, { id: 'inv-2' })).toBe(false);
    expect(await store.idempotencyResult('one', 'invite', 'same-key')).toEqual({ id: 'inv-1' });
    database.close();
  });

  it('creates claim identities insert-only and never rewrites a conflicting payload', async () => {
    const { database, store } = fixture();
    expect(await store.createOrganization(organization('claim', 'first.test'), audit('claim-1', 'claim', 'organization.claimed', 'same-key'))).toBe(true);
    expect(await store.createOrganization({ ...organization('claim', 'second.test'), name: 'replacement' },
      audit('claim-2', 'claim', 'organization.claimed', 'same-key'))).toBe(false);
    expect(await store.getOrganization('claim')).toMatchObject({ name: 'claim', domain: 'first.test' });
    database.close();
  });

  it('prevents challenge replay, expires verification, and applies token retention', async () => {
    const { database, store } = fixture();
    await store.putOrganization(organization('one'));
    await store.putChallenge({ id: 'challenge', organizationId: 'one', method: 'dns-txt', tokenHash: 'hash',
      createdAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-27T00:00:00.000Z' });
    expect(await store.consumeChallenge('challenge', '2026-08-26T00:00:00.000Z')).toBe(true);
    expect(await store.consumeChallenge('challenge', '2026-08-26T00:00:01.000Z')).toBe(false);
    await store.putChallenge({ id: 'expired', organizationId: 'one', method: 'well-known', tokenHash: 'old',
      createdAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-25T00:00:00.000Z' });
    expect(await store.deleteExpiredChallenges(new Date(now))).toBe(1);
    expect(await store.challengeByTokenHash('old')).toBeUndefined();

    await store.putVerification({ organizationId: 'one', state: 'verified', updatedAt: now,
      verifiedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-06-30T00:00:00.000Z' });
    expect(await store.expireVerifications(new Date(now))).toBe(1);
    expect(await store.getVerification('one')).toMatchObject({ state: 'expired', updatedAt: now });

    await store.putInvitation({ id: 'recent', organizationId: 'one', email: 'a@one.test', role: 'editor', tokenHash: 'i1',
      createdAt: now, expiresAt: '2026-08-25T00:00:00.000Z' });
    await store.putInvitation({ id: 'old', organizationId: 'one', email: 'b@one.test', role: 'editor', tokenHash: 'i2',
      createdAt: now, expiresAt: '2026-08-18T23:59:59.000Z' });
    expect(await store.deleteExpiredInvitations(new Date(now))).toBe(1);
    expect(await store.invitationByTokenHash('i1')).toBeDefined();
    expect(await store.invitationByTokenHash('i2')).toBeUndefined();
    database.close();
  });

  it('round-trips sources, proposals, submissions, reports, and publishing privileges', async () => {
    const { database, store } = fixture();
    await store.putOrganization(organization('one'));
    await store.putSource({ id: 'source', organizationId: 'one', provider: 'greenhouse', url: 'https://boards.greenhouse.io/one',
      state: 'shadow', createdAt: now, updatedAt: now });
    expect(await store.listSources('one')).toEqual([expect.objectContaining({ id: 'source', state: 'shadow' })]);
    await store.putReviewedSource({ sourceId: 'greenhouse:one', provider: 'greenhouse', organizationId: 'one',
      config: { boardToken: 'one' }, evidence: { reviewedBy: 'maintainer' }, state: 'active', createdAt: now, updatedAt: now });
    expect(await store.listReviewedSources('greenhouse', ['active'])).toEqual([
      expect.objectContaining({ sourceId: 'greenhouse:one', config: { boardToken: 'one' }, state: 'active' }),
    ]);
    expect(await store.listReviewedSources(undefined, [])).toEqual([]);

    await store.putFieldProposal({ id: 'proposal', organizationId: 'one', jobId: 'job', field: 'deadline',
      originalValue: null, proposedValue: '2026-09-01', evidenceAt: now, state: 'pending-review', createdBy: 'user', createdAt: now });
    expect(await store.listFieldProposals('one', 'pending-review')).toEqual([
      expect.objectContaining({ originalValue: null, proposedValue: '2026-09-01' }),
    ]);

    await store.putSubmission({ id: 'submission', organizationId: 'one', title: 'Intern', company: 'one',
      programType: 'internship', discipline: 'software', location: 'Remote', workMode: 'remote', season: 'summer-2027',
      applicationUrl: 'https://one.test/apply', deadline: 'rolling', workAuthorization: 'unknown', state: 'draft',
      createdBy: 'user', createdAt: now, updatedAt: now });
    expect(await store.getSubmission('one', 'submission')).toMatchObject({ deadline: 'rolling', workAuthorization: 'unknown' });
    expect(await store.getSubmission('other', 'submission')).toBeUndefined();

    await store.putOrganization(organization('two'));
    await expect(store.putReport({ id: 'cross-org-report', organizationId: 'two', submissionId: 'submission',
      reporterKey: 'installation:hash', category: 'destination', state: 'open', createdAt: now })).rejects.toThrow();

    await store.putReport({ id: 'report', organizationId: 'one', submissionId: 'submission', reporterKey: 'installation:hash',
      category: 'destination', state: 'open', createdAt: now });
    expect(await store.listReports('one', 'open')).toHaveLength(1);
    await store.putPublishingPrivilege({ organizationId: 'one', automaticPublishingEnabled: true,
      enabledAt: now, enabledBy: 'reviewer', updatedAt: now });
    expect(await store.getPublishingPrivilege('one')).toMatchObject({ automaticPublishingEnabled: true, enabledBy: 'reviewer' });
    database.close();
  });

  it('redacts private workflow data after a closed organization retention window', async () => {
    const { database, store } = fixture();
    await store.putOrganization({ ...organization('retained'), state: 'closed', closedAt: now, retainUntil: '2026-08-25T00:00:00.000Z' });
    await store.putMembership({ organizationId: 'retained', userId: 'owner', role: 'owner', createdAt: now, updatedAt: now });
    await store.appendAuditEvent({ ...audit('personal-audit', 'retained', 'membership.added', 'private-request-key'),
      subjectType: 'membership', subjectId: 'owner', details: { reason: 'person@example.test' } });
    const retainedAudit = (await store.listAuditEvents('retained'))[0]!;
    expect(JSON.stringify(retainedAudit)).not.toContain('owner');
    expect(JSON.stringify(retainedAudit)).not.toContain('person@example.test');
    expect(JSON.stringify(retainedAudit)).not.toContain('private-request-key');
    await store.putInvitation({ id: 'invite', organizationId: 'retained', email: 'person@retained.test', role: 'editor', tokenHash: 'secret-hash', createdAt: now, expiresAt: '2026-09-01T00:00:00.000Z' });
    await store.claimIdempotency('retained', 'operation', 'key', now, { private: 'result' });
    expect(await store.redactRetainedOrganizations(new Date(now))).toBe(1);
    expect(await store.getOrganization('retained')).toMatchObject({ name: 'Retained employer', domain: 'retained-retained.invalid', retainUntil: undefined });
    expect(await store.getMembership('retained', 'owner')).toBeUndefined();
    expect(await store.invitationByTokenHash('secret-hash')).toBeUndefined();
    expect(await store.idempotencyResult('retained', 'operation', 'key')).toBeUndefined();
    expect(await store.listAuditEvents('retained')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'membership.added', actorId: retainedAudit.actorId, details: expect.objectContaining({ evidenceDigest: expect.stringMatching(/^sha256:/u) }) }),
      expect.objectContaining({ action: 'organization.retention_redacted' }),
    ]));
    database.close();
  });
});
