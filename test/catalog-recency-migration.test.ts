import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { ashbyBaselineCandidate, migrateCatalogRecency, type CatalogRecencyMigrationItem } from '../src/migrate-catalog-recency.js';
import type { Internship, SourceOccurrence } from '../src/types.js';

const observedAt = '2026-08-09T16:00:00.000Z';
const reference = (sourceId = 'ashby-etched', overrides: Partial<SourceOccurrence> = {}): SourceOccurrence => ({
  sourceId, externalId: 'role-1', document: 'role-1', sourceUrl: 'https://jobs.ashbyhq.com/etched', row: 1,
  company: 'Etched', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
  applyUrl: 'https://jobs.ashbyhq.com/etched/role-1/application', compensation: { raw: '' }, state: 'open',
  firstAttachedAt: observedAt, firstAttachedAtPrecision: 'exact',
  providerTimestamp: { value: '2026-06-01T00:00:00.000Z', semantics: 'published' },
  ...overrides,
});
const job = (overrides: Partial<Internship> = {}): Internship => ({
  jobId: 'job-1', company: 'Etched', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
  applyUrl: 'https://jobs.ashbyhq.com/etched/role-1/application', normalizedUrl: 'https://jobs.ashbyhq.com/etched/role-1/application',
  fingerprint: 'etched-role-1', compensation: { raw: '' }, sourceReferences: [reference()], technical: true, open: true,
  firstSeenAt: observedAt, lastSeenAt: observedAt, notification: { smsPending: false, digestPending: false }, ...overrides,
});
const item = (overrides: Partial<CatalogRecencyMigrationItem> = {}): CatalogRecencyMigrationItem => ({
  pk: 'JOB#job-1', sk: 'META', job: job(), openPk: 'OPEN', openSk: `${observedAt}#job-1`, ...overrides,
});

describe('Ashby catalog-recency migration', () => {
  it('selects only confirmed Ashby baseline-created jobs', () => {
    expect(ashbyBaselineCandidate(item())?.sourceId).toBe('ashby-etched');
    expect(ashbyBaselineCandidate(item({ job: job({ firstSeenAt: '2026-08-08T16:00:00.000Z' }) }))).toBeUndefined();
    expect(ashbyBaselineCandidate(item({ job: job({ sourceReferences: [reference('community-list')] }) }))).toBeUndefined();
    expect(ashbyBaselineCandidate(item({ job: job({ sourceReferences: [reference('ashby-unreviewed')] }) }))).toBeUndefined();
    expect(ashbyBaselineCandidate(item({ job: job({ notification: { smsPending: false, digestPending: false, smsSentAt: observedAt } }) }))).toBeUndefined();
    expect(ashbyBaselineCandidate(item({ job: job({ catalogRecency: 'baseline', catalogVisibleAt: observedAt }) }))).toBeUndefined();
  });

  it('dry-runs deterministically, then applies a narrow conditional update', async () => {
    const dryRun = await migrateCatalogRecency('jobs', {
      send: vi.fn().mockResolvedValueOnce({ Items: [item(), { pk: 'SOURCE#ashby-etched', sk: 'CHECKPOINT' }] }),
    } as unknown as DynamoDBDocumentClient);
    expect(dryRun).toMatchObject({ scannedItems: 2, jobs: 1, candidates: 1, candidateJobIds: ['job-1'], repaired: 0 });
    expect(dryRun.repairToken).toMatch(/^[a-f0-9]{64}$/);

    const send = vi.fn().mockResolvedValueOnce({ Items: [item()] }).mockResolvedValueOnce({});
    const applied = await migrateCatalogRecency('jobs', { send } as unknown as DynamoDBDocumentClient, {
      apply: true, expectedCount: 1, expectedRepairToken: dryRun.repairToken,
    });
    expect(applied.repaired).toBe(1);
    const update = (send.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    expect(update).toMatchObject({
      Key: { pk: 'JOB#job-1', sk: 'META' },
      UpdateExpression: expect.stringContaining('SET #job.#catalogVisibleAt = :catalogVisibleAt, #job.#catalogRecency = :catalogRecency'),
      ConditionExpression: expect.stringContaining('#job.#sourceReferences = :sourceReferences'),
      ExpressionAttributeValues: expect.objectContaining({ ':catalogRecency': 'baseline', ':openSk': `1#${observedAt}#job-1` }),
    });
  });

  it('rejects stale guards and is idempotent after a successful repair', async () => {
    const legacy = item();
    const dryRun = await migrateCatalogRecency('jobs', {
      send: vi.fn().mockResolvedValueOnce({ Items: [legacy] }),
    } as unknown as DynamoDBDocumentClient);
    const staleSend = vi.fn().mockResolvedValueOnce({ Items: [legacy] });
    await expect(migrateCatalogRecency('jobs', { send: staleSend } as unknown as DynamoDBDocumentClient, {
      apply: true, expectedCount: 2, expectedRepairToken: dryRun.repairToken,
    })).rejects.toThrow('expected 2 candidates but found 1');
    expect(staleSend).toHaveBeenCalledTimes(1);

    const repaired = item({ job: job({ catalogVisibleAt: observedAt, catalogRecency: 'baseline' }), openSk: `1#${observedAt}#job-1` });
    const rerun = await migrateCatalogRecency('jobs', {
      send: vi.fn().mockResolvedValueOnce({ Items: [repaired] }),
    } as unknown as DynamoDBDocumentClient);
    expect(rerun).toMatchObject({ candidates: 0, candidateJobIds: [], repaired: 0 });
  });

  it('surfaces a conditional-write race without overwriting it', async () => {
    const dryRun = await migrateCatalogRecency('jobs', {
      send: vi.fn().mockResolvedValueOnce({ Items: [item()] }),
    } as unknown as DynamoDBDocumentClient);
    const race = Object.assign(new Error('job changed'), { name: 'ConditionalCheckFailedException' });
    const send = vi.fn().mockResolvedValueOnce({ Items: [item()] }).mockRejectedValueOnce(race);
    await expect(migrateCatalogRecency('jobs', { send } as unknown as DynamoDBDocumentClient, {
      apply: true, expectedCount: 1, expectedRepairToken: dryRun.repairToken,
    })).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });
});
