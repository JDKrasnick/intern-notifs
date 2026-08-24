import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createCandidateRelease, createNotificationIntents, deliveryClaimId, logicalTombstoneId, renderReleaseEmail, renderReleasePush, type DeliveryClaim, type NotificationIntent } from './release-notifications.js';
import { canonicalCompanyKey } from './core/normalize.js';
import { ExpoPushPublisher, SesEmailSender } from './notifications.js';
import { createDynamoDocumentClient, DynamoInternshipStore, DynamoReleaseStore, DynamoUserStore } from './store.js';
import type { NotificationEvent } from './types.js';

type SqsRecord = { messageId: string; body: string };
type SqsEvent = { Records?: SqsRecord[] };
type StreamRecord = {
  eventID: string;
  eventName?: string;
  dynamodb?: { Keys?: Record<string, AttributeValue>; NewImage?: Record<string, AttributeValue> };
};
type StreamEvent = { Records?: StreamRecord[] };
type AttributeValue = { S?: string; N?: string; BOOL?: boolean; NULL?: boolean; M?: Record<string, AttributeValue>; L?: AttributeValue[]; SS?: string[] };

const catalogTable = process.env.INTERNSHIPS_TABLE ?? '';
const usersTable = process.env.USERS_TABLE ?? '';
const documentClient = createDynamoDocumentClient(new DynamoDBClient({}));
const jobs = new DynamoInternshipStore(catalogTable, documentClient);
const users = new DynamoUserStore(usersTable, documentClient);
const releases = new DynamoReleaseStore(usersTable, documentClient);
const sns = new SNSClient({});
const sqs = new SQSClient({});

function unmarshall(value: AttributeValue | undefined): unknown {
  if (!value) return undefined;
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  if (value.SS) return new Set(value.SS);
  if (value.L) return value.L.map(unmarshall);
  if (value.M) return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, unmarshall(item)]));
  return undefined;
}

function normalizedEmployer(company: string) {
  return canonicalCompanyKey(company).replace(/\s+/g, '-') || 'unknown';
}

function bucketId(employerId: string, event: NotificationEvent) {
  return createHash('sha256').update(`${employerId}\0${event.createdAt}\0${event.eventId}`).digest('hex').slice(0, 24);
}

async function streamPublisher(event: StreamEvent) {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try {
      const pk = record.dynamodb?.Keys?.pk?.S;
      if (record.eventName !== 'INSERT' || !pk?.startsWith('OUTBOX#')) continue;
      const notification = unmarshall(record.dynamodb?.NewImage?.event) as NotificationEvent | undefined;
      if (!notification || notification.kind !== 'new-job') continue;
      await sns.send(new PublishCommand({ TopicArn: process.env.CANDIDATE_TOPIC_ARN, Message: JSON.stringify(notification) }));
    } catch { failures.push({ itemIdentifier: record.eventID }); }
  }
  return { batchItemFailures: failures };
}

async function aggregateCandidate(event: NotificationEvent) {
  const job = await jobs.getJob(event.jobId);
  if (!job?.open || job.technical === false) return;
  const employerId = normalizedEmployer(job.company);
  const pointerKey = { pk: `RELEASE_AGGREGATION#${employerId}`, sk: 'ACTIVE' };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pointer = (await documentClient.send(new GetCommand({ TableName: catalogTable, Key: pointerKey, ConsistentRead: true }))).Item as { bucketId?: string; flushAt?: string } | undefined;
    if (pointer?.bucketId && pointer.flushAt && event.createdAt <= pointer.flushAt) {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: catalogTable,
          Key: { pk: `RELEASE_BUCKET#${pointer.bucketId}`, sk: 'META' },
          UpdateExpression: 'ADD jobIds :jobIds',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':jobIds': new Set([event.jobId]) },
        }));
        return;
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
        continue;
      }
    }
    const id = bucketId(employerId, event);
    const flushAt = new Date(Date.parse(event.createdAt) + 8_000).toISOString();
    const condition = pointer?.bucketId ? '#bucketId = :prior' : 'attribute_not_exists(pk)';
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: catalogTable, Item: { pk: `RELEASE_BUCKET#${id}`, sk: 'META', bucketId: id, employerId, company: job.company, openedAt: event.createdAt, flushAt, jobIds: new Set([event.jobId]), expiresAtEpoch: Math.floor(Date.parse(flushAt) / 1_000) + 86_400 }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: catalogTable, Item: { ...pointerKey, bucketId: id, openedAt: event.createdAt, flushAt }, ConditionExpression: condition, ...(pointer?.bucketId ? { ExpressionAttributeNames: { '#bucketId': 'bucketId' }, ExpressionAttributeValues: { ':prior': pointer.bucketId } } : {}) } },
      ] }));
      await sqs.send(new SendMessageCommand({ QueueUrl: process.env.FLUSH_QUEUE_URL, MessageBody: JSON.stringify({ bucketId: id }) }));
      return;
    } catch (error) {
      if ((error as { name?: string }).name !== 'TransactionCanceledException' || attempt === 3) throw error;
    }
  }
}

async function aggregationWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => aggregateCandidate(JSON.parse(record.body) as NotificationEvent));
}

async function flushBucket(message: { bucketId: string }) {
  const result = await documentClient.send(new GetCommand({ TableName: catalogTable, Key: { pk: `RELEASE_BUCKET#${message.bucketId}`, sk: 'META' }, ConsistentRead: true }));
  const bucket = result.Item as { openedAt?: string; jobIds?: Set<string>; processedAt?: string } | undefined;
  if (!bucket?.openedAt || bucket.processedAt) return;
  const releaseJobs = (await Promise.all([...(bucket.jobIds ?? [])].map((jobId) => jobs.getJob(jobId))))
    .filter((job): job is NonNullable<typeof job> => Boolean(job?.open && job.technical !== false));
  if (!releaseJobs.length) return;
  const candidate = createCandidateRelease(releaseJobs, new Date(bucket.openedAt));
  const configuredCohort = (process.env.GROUPED_NOTIFICATION_USER_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const allUsers = configuredCohort.includes('*');
  const cohort = new Set(configuredCohort);
  const preferences = (await users.activePreferences()).filter((preference) => allUsers || cohort.has(preference.userId));
  for (const preference of preferences) {
    const channels = ['push', ...(preference.emailAlertsEnabled ? ['email' as const] : [])] as const;
    const intents = createNotificationIntents(candidate, preference.userId, preference.filter, [...channels], new Date(), preference.alertSettings?.quietHours);
    if (!intents.length) continue;
    const matchedJobIds = [...new Set(intents.flatMap((intent) => intent.release.jobs.map((job) => job.jobId)))].sort();
    await releases.putRelease({ releaseId: candidate.releaseId, userId: preference.userId, jobIds: matchedJobIds, newJobIds: matchedJobIds, createdAt: candidate.flushAt });
    for (const intent of intents) await sns.send(new PublishCommand({
      TopicArn: process.env.INTENT_TOPIC_ARN,
      Message: JSON.stringify(intent),
      MessageAttributes: { channel: { DataType: 'String', StringValue: intent.channel } },
    }));
  }
  await documentClient.send(new UpdateCommand({ TableName: catalogTable, Key: { pk: `RELEASE_BUCKET#${message.bucketId}`, sk: 'META' }, UpdateExpression: 'SET processedAt = :now', ExpressionAttributeValues: { ':now': new Date().toISOString() } }));
}

async function flushWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => flushBucket(JSON.parse(record.body) as { bucketId: string }));
}

async function deferIntent(intent: NotificationIntent, queueUrl: string) {
  const remaining = Date.parse(intent.eligibleAt) - Date.now();
  if (remaining <= 0) return false;
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(intent), DelaySeconds: Math.min(900, Math.max(1, Math.ceil(remaining / 1_000))) }));
  return true;
}

async function claimDelivery(intent: NotificationIntent, destinationId: string): Promise<DeliveryClaim | undefined> {
  const jobIds = intent.release.newlyMatchedJobIds;
  const tombstoneId = logicalTombstoneId(intent.release.userId, intent.channel, intent.release.releaseId, jobIds);
  const claimId = deliveryClaimId(tombstoneId, destinationId);
  const now = new Date().toISOString();
  const claim: DeliveryClaim = { claimId, tombstoneId, userId: intent.release.userId, channel: intent.channel, destinationId, releaseId: intent.release.releaseId, jobIds, state: 'claimed', createdAt: now, updatedAt: now };
  try {
    const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [{ Put: { TableName: usersTable, Item: { pk: `DELIVERY#${claimId}`, sk: 'CLAIM', claim }, ConditionExpression: 'attribute_not_exists(pk)' } }];
    if (intent.channel === 'email') writes.push({ Put: { TableName: usersTable, Item: { pk: `DELIVERY_TOMBSTONE#${tombstoneId}`, sk: 'CLAIM', createdAt: now }, ConditionExpression: 'attribute_not_exists(pk)' } });
    await documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
    return claim;
  } catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') return undefined;
    throw error;
  }
}

async function transitionClaim(claim: DeliveryClaim, state: DeliveryClaim['state'], providerId?: string) {
  await documentClient.send(new UpdateCommand({
    TableName: usersTable, Key: { pk: `DELIVERY#${claim.claimId}`, sk: 'CLAIM' },
    UpdateExpression: `SET claim.#state = :state, claim.updatedAt = :now${providerId ? ', claim.providerId = :providerId' : ''}`,
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: { ':state': state, ':now': new Date().toISOString(), ...(providerId ? { ':providerId': providerId } : {}) },
  }));
}

async function deliverPush(intent: NotificationIntent) {
  if (await deferIntent(intent, process.env.PUSH_QUEUE_URL ?? '')) return;
  const devices = (await users.activeDevices()).filter((device) => device.userId === intent.release.userId);
  const publisher = new ExpoPushPublisher();
  for (const device of devices) {
    const claim = await claimDelivery(intent, device.token);
    if (!claim) continue;
    try {
      const ticket = await publisher.publish(device.token, renderReleasePush(intent.release));
      if (ticket.status !== 'ok') {
        await transitionClaim(claim, 'definitive-failure', ticket.id);
        if (ticket.details?.error === 'DeviceNotRegistered') await users.putDevice({ ...device, active: false, updatedAt: new Date().toISOString() });
      } else if (!ticket.id) await transitionClaim(claim, 'unknown');
      else {
        await transitionClaim(claim, 'accepted', ticket.id);
        await sqs.send(new SendMessageCommand({ QueueUrl: process.env.RECEIPT_QUEUE_URL, MessageBody: JSON.stringify({ claim, ticketId: ticket.id, token: device.token }), DelaySeconds: 15 }));
      }
    } catch { await transitionClaim(claim, 'unknown'); }
  }
}

async function pushWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => deliverPush(JSON.parse(record.body) as NotificationIntent));
}

async function deliverEmail(intent: NotificationIntent) {
  if (await deferIntent(intent, process.env.EMAIL_QUEUE_URL ?? '')) return;
  const profile = await users.getProfile(intent.release.userId);
  const email = profile?.contact.email;
  if (!email) return;
  const claim = await claimDelivery(intent, createHash('sha256').update(email.toLowerCase()).digest('hex'));
  if (!claim) return;
  const rendered = renderReleaseEmail(intent.release);
  try {
    await new SesEmailSender(process.env.SES_FROM ?? '', email).send(rendered.subject, rendered.text, `<pre>${rendered.text.replace(/[&<>]/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[value]!))}</pre>`);
    await transitionClaim(claim, 'delivered');
  } catch { await transitionClaim(claim, 'unknown'); }
}

async function emailWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => deliverEmail(JSON.parse(record.body) as NotificationIntent));
}

async function receiptWorker(event: SqsEvent) {
  const publisher = new ExpoPushPublisher();
  return handleSqs(event, async (record) => {
    const message = JSON.parse(record.body) as { claim: DeliveryClaim; ticketId: string; token: string };
    const receipt = (await publisher.receipts([message.ticketId]))[message.ticketId];
    if (!receipt) throw new Error('Expo receipt is not ready');
    await transitionClaim(message.claim, receipt.status === 'ok' ? 'delivered' : 'definitive-failure', message.ticketId);
    if (receipt.details?.error === 'DeviceNotRegistered') {
      const device = (await users.activeDevices()).find((candidate) => candidate.userId === message.claim.userId && candidate.token === message.token);
      if (device) await users.putDevice({ ...device, active: false, updatedAt: new Date().toISOString() });
    }
  });
}

async function handleSqs(event: SqsEvent, action: (record: SqsRecord) => Promise<void>) {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try { await action(record); } catch { failures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures: failures };
}

export async function handler(event: SqsEvent | StreamEvent) {
  if (!catalogTable || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  switch (process.env.PIPELINE_COMMAND) {
    case 'stream-publisher': return streamPublisher(event as StreamEvent);
    case 'aggregate': return aggregationWorker(event as SqsEvent);
    case 'flush': return flushWorker(event as SqsEvent);
    case 'push': return pushWorker(event as SqsEvent);
    case 'email': return emailWorker(event as SqsEvent);
    case 'receipt': return receiptWorker(event as SqsEvent);
    default: throw new Error('PIPELINE_COMMAND is invalid');
  }
}
