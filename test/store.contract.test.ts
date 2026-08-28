import type { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createDynamoDocumentClient, deletedUserTombstoneKey, DynamoInternshipStore, DynamoUserStore, MemoryUserStore } from '../src/store.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { DeliveryReceipt, Internship } from '../src/types.js';

const job = (title = 'Software Engineering Intern', overrides: Partial<Internship> = {}): Internship => ({
  jobId: 'job-1', company: 'Acme', title, location: 'Remote', season: 'summer-2027', applyUrl: 'https://careers.example.test/job-1',
  normalizedUrl: 'https://careers.example.test/job-1', fingerprint: 'fingerprint-1', compensation: { raw: '$50/hr', maxHourlyUSD: 50 }, sourceReferences: [],
  technical: title !== 'Graduate Clinical Intern',
  open: true, firstSeenAt: '2026-07-19T00:00:00.000Z', catalogVisibleAt: '2026-07-19T00:00:00.000Z', catalogRecency: 'normal',
  lastSeenAt: '2026-07-19T00:00:00.000Z', notification: { smsPending: true, digestPending: true },
  ...overrides,
});
const fakeClient = () => {
  const send = vi.fn().mockResolvedValue({});
  return { send, client: { send } as unknown as DynamoDBDocumentClient };
};

describe('DynamoDB persistence contract', () => {
  it('removes undefined optional values when marshalling records', () => {
    const client = createDynamoDocumentClient();
    expect(client.config.translateConfig).toMatchObject({
      marshallOptions: { removeUndefinedValues: true },
    });
  });

  it('loads checkpoint evidence in one bounded batch', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Responses: { 'jobs-table': [
      { checkpoint: { sourceId: 'greenhouse-a', successfulFetches: 1, activeExternalIds: ['100'] } },
      { checkpoint: { sourceId: 'greenhouse-b', successfulFetches: 2, activeExternalIds: ['200'] } },
    ] } });
    expect(await store.getCheckpointsMany(['greenhouse-a', 'greenhouse-b'])).toMatchObject([
      { sourceId: 'greenhouse-a', activeExternalIds: ['100'] },
      { sourceId: 'greenhouse-b', activeExternalIds: ['200'] },
    ]);
    expect((send.mock.calls[0]?.[0] as BatchGetCommand).input).toMatchObject({ RequestItems: {
      'jobs-table': { Keys: [
        { pk: 'SOURCE#greenhouse-a', sk: 'CHECKPOINT' },
        { pk: 'SOURCE#greenhouse-b', sk: 'CHECKPOINT' },
      ] },
    } });
  });

  it('writes canonical and query-index keys only for open technical roles', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    await store.putInternship(job());
    const technical = (send.mock.calls[0]?.[0] as PutCommand).input;
    expect(technical.Item).toMatchObject({ pk: 'JOB#job-1', sk: 'META', urlPk: 'URL#https://careers.example.test/job-1', fingerprintPk: 'FP#fingerprint-1', smsPk: 'PENDING#SMS', digestPk: 'PENDING#DIGEST', openPk: 'OPEN', openSk: '3#2026-07-19T00:00:00.000Z#job-1' });
    await store.putInternship(job('Graduate Clinical Intern'));
    expect((send.mock.calls[1]?.[0] as PutCommand).input.Item).not.toHaveProperty('openPk');
  });

  it('rejects a migration rewrite when any scanned job state changed', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    const expected = job();
    const migrated = { ...expected, postingIdentity: { provider: 'unknown' as const, canonicalApplicationUrl: expected.applyUrl, aliases: [], canonicalJobId: expected.jobId } };
    send.mockRejectedValueOnce(Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' }));
    await expect(store.migrateInternship(migrated, expected)).resolves.toBe(false);
    expect((send.mock.calls[0]?.[0] as PutCommand).input).toMatchObject({
      ConditionExpression: 'job = :expectedJob',
      ExpressionAttributeValues: { ':expectedJob': expected },
    });
  });

  it('uses a stable opaque cursor with the open-jobs index', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Items: [{ job: job() }], LastEvaluatedKey: { pk: 'JOB#next', sk: 'META' } });
    const page = await store.listOpen!(Buffer.from(JSON.stringify({ pk: 'JOB#previous', sk: 'META' })).toString('base64url'), 10);
    expect(page.jobs).toMatchObject([{ jobId: 'job-1' }]);
    expect(JSON.parse(Buffer.from(page.cursor!, 'base64url').toString('utf8'))).toEqual({ pk: 'JOB#next', sk: 'META' });
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({ TableName: 'jobs-table', IndexName: 'openJobsIndex', ScanIndexForward: false, Limit: 10, ExclusiveStartKey: { pk: 'JOB#previous', sk: 'META' } });
  });

  it('materializes and pages the grouped catalog without reading job rows', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    const details = catalogGroupDetails(groupCatalogJobs([job()])[0]!);
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    await store.putCatalogProjection!([details], '2026-08-24T00:00:00.000Z');
    expect((send.mock.calls[0]?.[0] as BatchWriteCommand).input.RequestItems?.['jobs-table']).toEqual(expect.arrayContaining([
      expect.objectContaining({ PutRequest: { Item: expect.objectContaining({ pk: expect.stringContaining('CATALOG_PROJECTION#'), sk: expect.stringContaining('ORDER#'), details }) } }),
      expect.objectContaining({ PutRequest: { Item: expect.objectContaining({ pk: expect.stringContaining('CATALOG_PROJECTION#'), sk: expect.stringContaining('GROUP#'), details }) } }),
    ]));
    expect((send.mock.calls[1]?.[0] as PutCommand).input.Item).toMatchObject({ pk: 'CATALOG_PROJECTION', sk: 'CURRENT', schemaVersion: 4, groupCount: 1 });

    send.mockResolvedValueOnce({ Item: { schemaVersion: 4, version: 'version-a', generatedAt: new Date().toISOString() } });
    send.mockResolvedValueOnce({ Items: [{ details }] });
    expect(await store.listCatalogProjection!(undefined, 1)).toMatchObject({ groups: [details] });
    expect((send.mock.calls[2]?.[0] as GetCommand).input).toMatchObject({ Key: { pk: 'CATALOG_PROJECTION', sk: 'CURRENT' }, ConsistentRead: true });
    expect((send.mock.calls[3]?.[0] as QueryCommand).input).toMatchObject({
      TableName: 'jobs-table', ConsistentRead: true, Limit: 1, ScanIndexForward: true,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    });
    expect((send.mock.calls[3]?.[0] as QueryCommand).input).not.toHaveProperty('IndexName');
  });

  it('advances past an expired GSI page before returning an unfiltered catalog page', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Items: [{ job: job('Software Engineering Intern', { season: 'summer-2020' }) }], LastEvaluatedKey: { pk: 'JOB#expired', sk: 'META' } });
    send.mockResolvedValueOnce({ Items: [{ job: job('Software Engineering Intern', { jobId: 'live' }) }] });
    expect((await store.listOpen!(undefined, 10)).jobs).toMatchObject([{ jobId: 'live' }]);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: 'JOB#expired', sk: 'META' });
  });

  it('uses the catalog index query for search and source filters', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Items: [{ job: job() }] });
    await store.listOpen!(undefined, 10, 'open', { query: 'acme', source: 'direct' });
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({
      IndexName: 'openJobsIndex', KeyConditionExpression: 'openPk = :status',
      FilterExpression: 'contains(catalogSearchText, :query) AND contains(catalogSourceClasses, :source)',
      ExpressionAttributeValues: { ':status': 'OPEN', ':query': 'acme', ':source': 'direct' },
    });
  });

  it('queries the open-jobs index inside the launch interval', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Items: [
      { job: job() },
      { job: job('Software Engineering Intern', { jobId: 'past', season: 'summer-2020' }) },
    ] });
    expect(await store.listOpenSince('2026-07-18T00:00:00.000Z', '2026-07-19T00:00:00.000Z')).toMatchObject([{ jobId: 'job-1' }]);
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({
      TableName: 'jobs-table', IndexName: 'openJobsIndex',
      KeyConditionExpression: 'openPk = :open AND openSk BETWEEN :after AND :before',
      ExpressionAttributeValues: {
        ':open': 'OPEN',
        ':after': '3#2026-07-18T00:00:00.000Z\uffff',
        ':before': '3#2026-07-19T00:00:00.000Z\uffff',
      },
      ScanIndexForward: false,
    });
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExpressionAttributeValues).toEqual({
      ':open': 'OPEN', ':after': '2026-07-18T00:00:00.000Z\uffff', ':before': '2026-07-19T00:00:00.000Z\uffff',
    });
  });

  it('atomically writes a notification-pending job with its outbox event', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    await store.putInternshipWithNotificationEvent(job(), {
      eventId: 'event-1',
      sourceId: 'source-a',
      externalId: 'role-1',
      jobId: 'job-1',
      kind: 'new-job',
      createdAt: '2026-07-19T00:00:00.000Z',
    });

    expect((send.mock.calls[0]?.[0] as TransactWriteCommand).input.TransactItems).toEqual([
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'jobs-table',
          Item: expect.objectContaining({ pk: 'JOB#job-1', smsPk: 'PENDING#SMS', digestPk: 'PENDING#DIGEST' }),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'jobs-table',
          Item: expect.objectContaining({ pk: 'OUTBOX#event-1', sk: 'EVENT' }),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      }),
    ]);
  });

  it('claims unowned posting aliases in one conditional transaction', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    const identity = buildPostingIdentity({
      applicationUrl: 'https://boards.greenhouse.io/acme?gh_jid=100',
      reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'acme', postingId: '100' }],
    });
    send.mockResolvedValueOnce({ Responses: { 'jobs-table': [] } });
    const resolution = await store.claimPostingIdentity(identity, 'legacy-job');
    expect(resolution).toMatchObject({ outcome: 'create', canonicalJobId: 'legacy-job' });
    const transaction = (send.mock.calls[1]?.[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(transaction.length).toBeGreaterThan(1);
    expect(transaction).toEqual(expect.arrayContaining([
      expect.objectContaining({ Put: expect.objectContaining({
        TableName: 'jobs-table', ConditionExpression: 'attribute_not_exists(pk)',
        Item: expect.objectContaining({ alias: 'provider:greenhouse:acme:100', canonicalJobId: 'legacy-job' }),
      }) }),
    ]));
  });

  it('claims a push receipt only when absent or retryable', async () => {
    const { send, client } = fakeClient(); const store = new DynamoUserStore('users-table', client);
    const receipt: DeliveryReceipt = { userId: 'student-a', jobId: 'job-1', token: 'ExponentPushToken[test]', status: 'pending', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z' };
    expect(await store.claimReceipt(receipt)).toBe(true);
    expect((send.mock.calls[0]?.[0] as PutCommand).input).toMatchObject({
      TableName: 'users-table',
      Item: { pk: 'USER#student-a', sk: 'RECEIPT#job-1#ExponentPushToken[test]', kind: 'receipt', receiptPk: 'PENDING', value: receipt },
      ConditionExpression: 'attribute_not_exists(pk) OR #value.#status = :error',
      ExpressionAttributeValues: { ':error': 'error' },
    });
    send.mockRejectedValueOnce(Object.assign(new Error('claimed'), { name: 'ConditionalCheckFailedException' }));
    expect(await store.claimReceipt(receipt)).toBe(false);
  });

  it('copies a migrated receipt only when the hardened key is absent', async () => {
    const { send, client } = fakeClient(); const store = new DynamoUserStore('users-table', client);
    const receipt: DeliveryReceipt = { userId: 'student-a', jobId: 'legacy-job', token: 'ExponentPushToken[test]', status: 'ok', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:01.000Z' };
    expect(await store.migrateReceipt(receipt, 'strong-key')).toBe(true);
    expect((send.mock.calls[0]?.[0] as PutCommand).input).toMatchObject({
      Item: { pk: 'USER#student-a', sk: 'RECEIPT#strong-key#ExponentPushToken[test]', value: { jobId: 'legacy-job', dedupeKey: 'strong-key', status: 'ok' } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    send.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
    expect(await store.migrateReceipt(receipt, 'strong-key')).toBe(false);
  });

  it('deletes every user-owned item after returning the document list for object cleanup', async () => {
    const { send, client } = fakeClient(); const store = new DynamoUserStore('users-table', client);
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({ Items: [{ value: { userId: 'student-a', documentId: 'document-1', objectKey: 'private/student-a/document-1' } }] });
    send.mockResolvedValueOnce({ Items: [
      { pk: 'USER#student-a', sk: 'PREFERENCES' },
      { pk: 'USER#student-a', sk: 'DOCUMENT#document-1' },
      { pk: 'USER#student-a', sk: 'DELIVERY#claim-1' },
      { pk: 'USER#student-a', sk: 'DELIVERY_TOMBSTONE#tombstone-1' },
      { pk: 'USER#student-a', sk: 'PIPELINE_RECEIPT_OUTBOX#claim-1#ticket-1' },
    ] });
    const documents = await store.deleteUser('student-a');
    expect(documents).toMatchObject([{ documentId: 'document-1' }]);
    expect((send.mock.calls[0]?.[0] as PutCommand).input).toEqual({
      TableName: 'users-table',
      Item: { ...deletedUserTombstoneKey('student-a'), kind: 'deleted-user-tombstone' },
    });
    expect(deletedUserTombstoneKey('student-a').pk).not.toContain('student-a');
    expect(send.mock.calls.slice(1, 3).map(([command]) => (command as QueryCommand).input)).toEqual([
      expect.objectContaining({ KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)' }),
      expect.objectContaining({ KeyConditionExpression: 'pk = :pk' }),
    ]);
    expect(send.mock.calls.slice(3).map(([command]) => (command as { input: unknown }).input)).toEqual([
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'PREFERENCES' } }),
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'DOCUMENT#document-1' } }),
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'DELIVERY#claim-1' } }),
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'DELIVERY_TOMBSTONE#tombstone-1' } }),
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'PIPELINE_RECEIPT_OUTBOX#claim-1#ticket-1' } }),
    ]);
  });

  it('walks DynamoDB query pages and keeps applications sorted by updated time', async () => {
    const { send, client } = fakeClient(); const store = new DynamoUserStore('users-table', client);
    send.mockResolvedValueOnce({ Items: [{ value: { applicationId: 'old', updatedAt: '2026-07-01T00:00:00.000Z' } }], LastEvaluatedKey: { pk: 'USER#student-a', sk: 'APPLICATION#old' } });
    send.mockResolvedValueOnce({ Items: [{ value: { applicationId: 'new', updatedAt: '2026-07-02T00:00:00.000Z' } }] });
    expect((await store.listApplications('student-a')).map((application) => application.applicationId)).toEqual(['new', 'old']);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: 'USER#student-a', sk: 'APPLICATION#old' });
  });

  it('removes notification receipts alongside every other memory-store record during account deletion', async () => {
    const store = new MemoryUserStore();
    await store.putReceipt({ userId: 'student-a', jobId: 'job-1', token: 'ExponentPushToken[token]', status: 'pending', ticketId: 'ticket', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    await store.deleteUser('student-a');
    expect(await store.getReceipt('student-a', 'job-1', 'ExponentPushToken[token]')).toBeUndefined();
    expect(store.deletedUsers).toContain(deletedUserTombstoneKey('student-a').pk);
  });
});
