import type { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoInternshipStore, DynamoUserStore, MemoryUserStore } from '../src/store.js';
import type { Internship } from '../src/types.js';

const job = (title = 'Software Engineering Intern'): Internship => ({
  jobId: 'job-1', company: 'Acme', title, location: 'Remote', season: 'summer-2027', applyUrl: 'https://careers.example.test/job-1',
  normalizedUrl: 'https://careers.example.test/job-1', fingerprint: 'fingerprint-1', compensation: { raw: '$50/hr', maxHourlyUSD: 50 }, sourceReferences: [],
  open: true, firstSeenAt: '2026-07-19T00:00:00.000Z', lastSeenAt: '2026-07-19T00:00:00.000Z', notification: { smsPending: true, digestPending: true },
});
const fakeClient = () => {
  const send = vi.fn().mockResolvedValue({});
  return { send, client: { send } as unknown as DynamoDBDocumentClient };
};

describe('DynamoDB persistence contract', () => {
  it('writes canonical and query-index keys only for open technical roles', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    await store.putInternship(job());
    const technical = (send.mock.calls[0]?.[0] as PutCommand).input;
    expect(technical.Item).toMatchObject({ pk: 'JOB#job-1', sk: 'META', urlPk: 'URL#https://careers.example.test/job-1', fingerprintPk: 'FP#fingerprint-1', smsPk: 'PENDING#SMS', digestPk: 'PENDING#DIGEST', openPk: 'OPEN' });
    await store.putInternship(job('Graduate Clinical Intern'));
    expect((send.mock.calls[1]?.[0] as PutCommand).input.Item).not.toHaveProperty('openPk');
  });

  it('uses a stable opaque cursor with the open-jobs index', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Items: [{ job: job() }], LastEvaluatedKey: { pk: 'JOB#next', sk: 'META' } });
    const page = await store.listOpen!(Buffer.from(JSON.stringify({ pk: 'JOB#previous', sk: 'META' })).toString('base64url'), 10);
    expect(page.jobs).toMatchObject([{ jobId: 'job-1' }]);
    expect(JSON.parse(Buffer.from(page.cursor!, 'base64url').toString('utf8'))).toEqual({ pk: 'JOB#next', sk: 'META' });
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({ TableName: 'jobs-table', IndexName: 'openJobsIndex', ScanIndexForward: false, Limit: 10, ExclusiveStartKey: { pk: 'JOB#previous', sk: 'META' } });
  });

  it('queries the open-jobs index inside the launch interval', async () => {
    const { send, client } = fakeClient(); const store = new DynamoInternshipStore('jobs-table', client);
    send.mockResolvedValueOnce({ Items: [{ job: job() }] });
    expect(await store.listOpenSince('2026-07-18T00:00:00.000Z', '2026-07-19T00:00:00.000Z')).toMatchObject([{ jobId: 'job-1' }]);
    expect((send.mock.calls[0]?.[0] as QueryCommand).input).toMatchObject({
      TableName: 'jobs-table', IndexName: 'openJobsIndex',
      KeyConditionExpression: 'openPk = :open AND openSk BETWEEN :after AND :before',
      ExpressionAttributeValues: {
        ':open': 'OPEN',
        ':after': '2026-07-18T00:00:00.000Z\uffff',
        ':before': '2026-07-19T00:00:00.000Z\uffff',
      },
      ScanIndexForward: false,
    });
  });

  it('deletes every user-owned item after returning the document list for object cleanup', async () => {
    const { send, client } = fakeClient(); const store = new DynamoUserStore('users-table', client);
    send.mockResolvedValueOnce({ Items: [{ value: { userId: 'student-a', documentId: 'document-1', objectKey: 'private/student-a/document-1' } }] });
    send.mockResolvedValueOnce({ Items: [{ pk: 'USER#student-a', sk: 'PREFERENCES' }, { pk: 'USER#student-a', sk: 'DOCUMENT#document-1' }] });
    const documents = await store.deleteUser('student-a');
    expect(documents).toMatchObject([{ documentId: 'document-1' }]);
    expect(send.mock.calls.slice(0, 2).map(([command]) => (command as QueryCommand).input)).toEqual([
      expect.objectContaining({ KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)' }),
      expect.objectContaining({ KeyConditionExpression: 'pk = :pk' }),
    ]);
    expect(send.mock.calls.slice(2).map(([command]) => (command as { input: unknown }).input)).toEqual([
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'PREFERENCES' } }),
      expect.objectContaining({ Key: { pk: 'USER#student-a', sk: 'DOCUMENT#document-1' } }),
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
  });
});
