import { describe, expect, it } from 'vitest';
import { planPostingIdentityMigration } from '../src/migrate-posting-identity.js';
import type { DeliveryReceipt, Internship } from '../src/types.js';

function job(jobId: string, applyUrl: string, firstSeenAt: string, open = true): Internship {
  return {
    jobId, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl, normalizedUrl: applyUrl, fingerprint: 'same-display-fingerprint', compensation: { raw: '' }, sourceReferences: [],
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

describe('posting identity migration plan', () => {
  it('merges exact open aliases into the oldest canonical job and copies receipt tombstones', () => {
    const plan = planPostingIdentityMigration([
      job('legacy-a', 'https://boards.greenhouse.io/acme?gh_jid=100', '2026-08-01T00:00:00.000Z'),
      job('legacy-b', 'https://job-boards.greenhouse.io/acme/jobs/100', '2026-08-02T00:00:00.000Z'),
    ], [receipt('legacy-b')]);

    expect(plan).toMatchObject({ jobUpdates: 1, duplicateOpenJobs: 1, receiptCopies: 1, conflicts: [] });
    expect(plan.duplicateIds).toEqual(['legacy-b']);
    expect(plan.updates[0]).toMatchObject({ jobId: 'legacy-a', postingIdentity: { canonicalJobId: 'legacy-a', providerPostingId: '100' } });
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
});
