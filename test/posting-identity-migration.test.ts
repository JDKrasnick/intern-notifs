import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { migratePostingIdentity, planPostingIdentityMigration } from '../src/migrate-posting-identity.js';
import type { ApplicationSession } from '../src/application-automation.js';
import type { ApplicationRecord, DeliveryReceipt, Internship } from '../src/types.js';

function job(jobId: string, applyUrl: string, firstSeenAt: string, open = true): Internship {
  const greenhouseId = applyUrl.includes('greenhouse.io')
    ? /(?:\/jobs\/|[?&]gh_jid=)(\d+)/u.exec(applyUrl)?.[1]
    : undefined;
  const sourceReferences = greenhouseId ? [{
    sourceId: 'greenhouse-acme', externalId: greenhouseId, document: greenhouseId,
    sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl, compensation: { raw: '' }, state: 'open' as const,
    providerEvidence: {
      provider: 'greenhouse' as const, tenant: 'acme', postingId: greenhouseId,
      sourceId: 'greenhouse-acme', urls: [applyUrl],
    },
  }] : [];
  return {
    jobId, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl, normalizedUrl: applyUrl, fingerprint: 'same-display-fingerprint', compensation: { raw: '' }, sourceReferences,
    technical: true, open, firstSeenAt, catalogVisibleAt: firstSeenAt, lastSeenAt: firstSeenAt,
    notification: { smsPending: false, digestPending: false },
  };
}

function receipt(jobId: string): DeliveryReceipt {
  return {
    userId: 'student', jobId, token: 'ExponentPushToken[test]', status: 'ok',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:01.000Z',
  };
}

function application(applicationId: string, jobId: string, status: ApplicationRecord['status'], createdAt: string, updatedAt: string, notes?: string) {
  return {
    userId: 'student', pk: 'USER#student', sk: `APPLICATION#${applicationId}`,
    application: { applicationId, jobId, status, createdAt, updatedAt, notes } satisfies ApplicationRecord,
  };
}

function session(sessionId: string, applicationId: string, jobId: string): { userId: string; pk: string; sk: string; session: ApplicationSession } {
  return {
    userId: 'student', pk: 'USER#student', sk: `APPLICATION_SESSION#${sessionId}`,
    session: {
      sessionId, userId: 'student', applicationId, jobId, mode: 'headed', status: 'awaiting-user-review',
      version: 1, fields: [], fieldPlanDigest: 'digest', runnerLifecycle: 'paused',
      expiresAt: '2026-08-03T00:00:00.000Z', metadataExpiresAt: '2026-09-03T00:00:00.000Z',
      eventIds: [], createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
    },
  };
}

describe('posting identity migration plan', () => {
  it('leaves syntactically matching unreviewed URLs unclassified and separate', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://careers.example.test/jobs/42?utm_source=one', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://careers.example.test/jobs/42?utm_source=two', '2026-08-02T00:00:00.000Z'),
    ], []);
    expect(plan).toMatchObject({ identityClaims: 0, jobUpdates: 0, duplicateOpenJobs: 0, conflicts: [] });
  });

  it('merges exact open aliases into the oldest canonical job and copies receipt tombstones', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ], [receipt('legacy-b')]);

    expect(plan).toMatchObject({ jobUpdates: 1, duplicateOpenJobs: 1, receiptCopies: 1, conflicts: [] });
    expect(plan.duplicateIds).toEqual(['legacy-b']);
    expect(plan.updates[0]).toMatchObject({ jobId: 'legacy-a', postingIdentity: { canonicalJobId: 'legacy-a' } });
    expect(plan.receipts[0]).toMatchObject({ canonicalJobId: 'legacy-a', receipt: { status: 'ok' } });
  });

  it('never merges distinct provider requisitions on display similarity', () => {
    const plan = planPostingIdentityMigration([
      job('one', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-01T00:00:00.000Z'),
      job('two', 'https://job-boards.greenhouse.io/acme/jobs/101', '2026-08-01T00:00:00.000Z'),
    ], []);
    expect(plan).toMatchObject({ jobUpdates: 2, duplicateOpenJobs: 0, conflicts: [] });
    expect(plan.updates.map((value) => value.jobId).sort()).toEqual(['one', 'two']);
  });

  it('migrates a closed receipt job without deleting the historical role', () => {
    const plan = planPostingIdentityMigration([
      job('closed', 'https://jobs.ashbyhq.com/acme/00000000-0000-0000-0000-000000000001', '2026-07-01T00:00:00.000Z', false),
    ], [receipt('closed')]);
    expect(plan).toMatchObject({ referencedJobs: 1, jobUpdates: 1, duplicateOpenJobs: 0, receiptCopies: 1 });
    expect(plan.updates[0]?.postingIdentity?.canonicalJobId).toBe('closed');
  });

  it('remaps saved applications, merges user collisions, and repairs their sessions before deleting aliases', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ], [], [
      application('application-a', 'legacy-a', 'saved', '2026-08-01T00:00:00.000Z', '2026-08-01T12:00:00.000Z', 'Ask about relocation.'),
      application('application-b', 'legacy-b', 'applied', '2026-08-02T00:00:00.000Z', '2026-08-03T12:00:00.000Z', 'Submitted on the official site.'),
    ], [
      session('session-a', 'application-a', 'legacy-a'),
      session('session-b', 'application-b', 'legacy-b'),
    ]);

    expect(plan).toMatchObject({
      duplicateOpenJobs: 1, applicationRows: 2, applicationRemaps: 1, applicationMerges: 1, applicationSessionRemaps: 2,
    });
    expect(plan.applications.writes).toEqual([{
      pk: 'USER#student', sk: 'APPLICATION#application-b', expectedUpdatedAt: '2026-08-03T12:00:00.000Z',
      application: {
        applicationId: 'application-b', jobId: 'legacy-a', status: 'applied',
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-03T12:00:00.000Z',
        notes: 'Ask about relocation.\n\nSubmitted on the official site.',
      },
    }]);
    expect(plan.applications.deletes).toEqual([{
      pk: 'USER#student', sk: 'APPLICATION#application-a', applicationId: 'application-a', expectedUpdatedAt: '2026-08-01T12:00:00.000Z',
    }]);
    expect(plan.applications.sessionWrites.map(({ session: value }) => value)).toEqual([
      expect.objectContaining({ sessionId: 'session-a', applicationId: 'application-b', jobId: 'legacy-a' }),
      expect.objectContaining({ sessionId: 'session-b', applicationId: 'application-b', jobId: 'legacy-a' }),
    ]);
  });

  it('keeps a saved application usable when its only job alias is deleted', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ], [], [
      application('application-b', 'legacy-b', 'saved', '2026-08-02T00:00:00.000Z', '2026-08-02T12:00:00.000Z'),
    ]);

    expect(plan.applications.writes).toEqual([expect.objectContaining({
      application: expect.objectContaining({ applicationId: 'application-b', jobId: 'legacy-a', status: 'saved' }),
    })]);
    expect(plan.applications.deletes).toEqual([]);
  });

  it('never downgrades an older progressed application when a newer saved alias collides', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ], [], [
      application('application-a', 'legacy-a', 'interview', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      application('application-b', 'legacy-b', 'saved', '2026-08-03T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
    ]);

    expect(plan.applications.writes[0]?.application).toMatchObject({
      applicationId: 'application-b', jobId: 'legacy-a', status: 'interview',
    });
  });

  it('preserves the furthest application state instead of a newer less-progressed alias', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ], [], [
      application('application-a', 'legacy-a', 'offer', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      application('application-b', 'legacy-b', 'applied', '2026-08-03T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
    ]);

    expect(plan.applications.writes[0]?.application.status).toBe('offer');
  });

  it('chooses the strongest receipt tombstone deterministically when aliases collapse', () => {
    const jobs = [
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ];
    const failed = { ...receipt('legacy-a'), status: 'error' as const };
    const delivered = { ...receipt('legacy-b'), status: 'ok' as const };
    const forward = planPostingIdentityMigration(jobs, [failed, delivered]);
    const reverse = planPostingIdentityMigration(jobs, [delivered, failed]);
    expect(forward.receipts).toHaveLength(1);
    expect(reverse.receipts).toHaveLength(1);
    expect(forward.receipts[0]?.receipt.status).toBe('ok');
    expect(reverse.receipts[0]?.receipt.status).toBe('ok');
    expect(forward.repairToken).toBe(reverse.repairToken);
  });

  it('applies application and session repairs before deleting duplicate applications and jobs', async () => {
    const jobs = [
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ];
    const applications = [
      application('application-a', 'legacy-a', 'saved', '2026-08-01T00:00:00.000Z', '2026-08-01T12:00:00.000Z'),
      application('application-b', 'legacy-b', 'applied', '2026-08-02T00:00:00.000Z', '2026-08-03T12:00:00.000Z'),
    ];
    const sessions = [session('session-a', 'application-a', 'legacy-a')];
    const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'ScanCommand') {
        if (command.input.TableName === 'internships') {
          return { Items: jobs.map((value) => ({ pk: `JOB#${value.jobId}`, sk: 'META', job: value })) };
        }
        return { Items: [
          ...applications.map((value) => ({ pk: value.pk, sk: value.sk, kind: 'application', value: value.application })),
          ...sessions.map((value) => ({ pk: value.pk, sk: value.sk, kind: 'application-session', value: value.session })),
        ] };
      }
      return {};
    });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const dryRun = await migratePostingIdentity('internships', 'users', client);
    send.mockClear();

    const applied = await migratePostingIdentity('internships', 'users', client, {
      apply: true, expectedRepairToken: dryRun.repairToken,
    });
    expect(applied).toMatchObject({ applied: true, applicationRemaps: 1, applicationMerges: 1, applicationSessionRemaps: 1 });

    const commands = send.mock.calls.map(([command]) => command as unknown as { constructor: { name: string }; input: Record<string, unknown> });
    const applicationWrite = commands.findIndex(({ constructor, input }) => constructor.name === 'UpdateCommand'
      && input.TableName === 'users' && (input.Key as { sk?: string }).sk === 'APPLICATION#application-b');
    const sessionWrite = commands.findIndex(({ constructor, input }) => constructor.name === 'UpdateCommand'
      && input.TableName === 'users' && (input.Key as { sk?: string }).sk === 'APPLICATION_SESSION#session-a');
    const applicationDelete = commands.findIndex(({ constructor, input }) => constructor.name === 'DeleteCommand'
      && input.TableName === 'users');
    const jobDelete = commands.findIndex(({ constructor, input }) => constructor.name === 'DeleteCommand'
      && input.TableName === 'internships');
    expect([applicationWrite, sessionWrite, applicationDelete, jobDelete].every((index) => index >= 0)).toBe(true);
    expect(applicationWrite).toBeLessThan(applicationDelete);
    expect(sessionWrite).toBeLessThan(applicationDelete);
    expect(applicationDelete).toBeLessThan(jobDelete);
  });
});
