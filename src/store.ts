import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { isPastSeason } from './core/early-career.js';
import { employerCategory } from './core/employers.js';
import type { ApplicantProfile, ApplicationRecord, DeliveryReceipt, DeviceToken, Internship, MonitoringChecklist, NotificationEvent, SourceCheckpoint, SourceHealth, SourceOccurrenceState, UserDocument, UserPreferences } from './types.js';
import type { ApplicationSession } from './application-automation.js';
import type { ReviewedLeverSource } from './sources/lever-config.js';
import type { LeverOwnershipEvidence } from './sources/lever-evidence.js';
import type { LeverCandidateProbeResult } from './sources/lever-probe.js';

export interface LeverAdmission {
  source: ReviewedLeverSource;
  evidence: LeverOwnershipEvidence;
  probe: LeverCandidateProbeResult & { state: 'ok' };
  acceptedAt: string;
  acceptedBy: string;
}

function withEmployerCategory(job: Internship): Internship {
  return { ...structuredClone(job), employerCategory: job.employerCategory ?? employerCategory(job.company) };
}

/** Optional listing/profile fields are omitted rather than rejected by DynamoDB. */
export function createDynamoDocumentClient(client = new DynamoDBClient({})): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export interface InternshipStore {
  getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined>;
  putCheckpoint(checkpoint: SourceCheckpoint): Promise<void>;
  getSourceHealth(sourceId: string): Promise<SourceHealth | undefined>;
  getSourceHealthMany(sourceIds: string[]): Promise<SourceHealth[]>;
  putSourceHealth(health: SourceHealth): Promise<void>;
  getMonitoringChecklist(period: string): Promise<MonitoringChecklist | undefined>;
  putMonitoringChecklist(checklist: MonitoringChecklist): Promise<void>;
  findByUrl(url: string): Promise<Internship | undefined>;
  findByFingerprint(fingerprint: string): Promise<Internship | undefined>;
  putInternship(job: Internship): Promise<void>;
  getJob(jobId: string): Promise<Internship | undefined>;
  getSourceOccurrences(sourceId: string): Promise<SourceOccurrenceState[]>;
  putSourceOccurrence(occurrence: SourceOccurrenceState): Promise<void>;
  /** Atomically exposes a notification-pending job and records its deterministic outbox event. */
  putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent): Promise<boolean>;
  pendingSms(): Promise<Internship[]>;
  pendingDigest(): Promise<Internship[]>;
  markSmsSent(jobIds: string, sentAt: string): Promise<void>;
  markDigested(jobIds: string[], sentAt: string): Promise<void>;
  listOpen?(cursor?: string, limit?: number, status?: 'open' | 'closed'): Promise<{ jobs: Internship[]; cursor?: string }>;
  listLeverAdmissions?(): Promise<LeverAdmission[]>;
  putLeverAdmission?(admission: LeverAdmission): Promise<void>;
  /** Open technical roles discovered strictly after `after` and no later than `before`. */
  listOpenSince(after: string, before: string): Promise<Internship[]>;
}

export class MemoryInternshipStore implements InternshipStore {
  readonly jobs = new Map<string, Internship>();
  readonly checkpoints = new Map<string, SourceCheckpoint>();
  readonly occurrences = new Map<string, SourceOccurrenceState>();
  readonly notificationEvents = new Map<string, NotificationEvent>();
  readonly sourceHealth = new Map<string, SourceHealth>();
  readonly monitoringChecklists = new Map<string, MonitoringChecklist>();
  readonly leverAdmissions = new Map<string, LeverAdmission>();
  async getCheckpoint(sourceId: string) { return this.checkpoints.get(sourceId); }
  async putCheckpoint(checkpoint: SourceCheckpoint) { this.checkpoints.set(checkpoint.sourceId, checkpoint); }
  async getSourceHealth(sourceId: string) { return this.sourceHealth.get(sourceId); }
  async getSourceHealthMany(sourceIds: string[]) { return sourceIds.map((id) => this.sourceHealth.get(id)).filter((value): value is SourceHealth => Boolean(value)); }
  async putSourceHealth(health: SourceHealth) { this.sourceHealth.set(health.sourceId, structuredClone(health)); }
  async getMonitoringChecklist(period: string) { return structuredClone(this.monitoringChecklists.get(period)); }
  async putMonitoringChecklist(checklist: MonitoringChecklist) { this.monitoringChecklists.set(checklist.period, structuredClone(checklist)); }
  async findByUrl(url: string) { return [...this.jobs.values()].find((job) => job.normalizedUrl === url); }
  async findByFingerprint(fingerprint: string) { return [...this.jobs.values()].find((job) => job.fingerprint === fingerprint); }
  async putInternship(job: Internship) { this.jobs.set(job.jobId, structuredClone(job)); }
  async getSourceOccurrences(sourceId: string) { return [...this.occurrences.values()].filter((value) => value.sourceId === sourceId).map((value) => structuredClone(value)); }
  async putSourceOccurrence(occurrence: SourceOccurrenceState) { this.occurrences.set(`${occurrence.sourceId}#${occurrence.externalId}`, structuredClone(occurrence)); }
  async putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent) {
    if (this.notificationEvents.has(event.eventId)) return false;
    this.jobs.set(job.jobId, structuredClone(job));
    this.notificationEvents.set(event.eventId, structuredClone(event));
    return true;
  }
  async pendingSms() { return [...this.jobs.values()].filter((job) => job.notification.smsPending && job.open); }
  async pendingDigest() { return [...this.jobs.values()].filter((job) => job.notification.digestPending && job.open); }
  async markSmsSent(jobId: string, sentAt: string) { const job = this.jobs.get(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = this.jobs.get(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; } } }
  async getJob(jobId: string) { const job = this.jobs.get(jobId); return job && withEmployerCategory(job); }
  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open') { const jobs = [...this.jobs.values()].filter((job) => job.open === (status === 'open') && job.technical !== false && !isPastSeason(job.season)).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)); const offset = cursor ? Number(cursor) : 0; const page = jobs.slice(offset, offset + limit).map(withEmployerCategory); return { jobs: page, cursor: offset + page.length < jobs.length ? String(offset + page.length) : undefined }; }
  async listOpenSince(after: string, before: string) {
    return [...this.jobs.values()]
      .filter((job) => job.open && job.technical !== false && !isPastSeason(job.season) && job.firstSeenAt > after && job.firstSeenAt <= before)
      .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
      .map(withEmployerCategory);
  }
  async listLeverAdmissions() { return [...this.leverAdmissions.values()].map((value) => structuredClone(value)); }
  async putLeverAdmission(admission: LeverAdmission) {
    if (this.leverAdmissions.has(admission.source.site)) throw new Error(`Lever site ${admission.source.site} is already admitted`);
    this.leverAdmissions.set(admission.source.site, structuredClone(admission));
  }
}

type JobItem = { pk: string; sk: 'META'; urlPk: string; fingerprintPk: string; smsPk?: string; digestPk?: string; openPk?: string; openSk?: string; closedPk?: string; closedSk?: string; job: Internship };

function internshipItem(job: Internship): JobItem {
  const item: JobItem = { pk: `JOB#${job.jobId}`, sk: 'META', urlPk: `URL#${job.normalizedUrl}`, fingerprintPk: `FP#${job.fingerprint}`, job };
  if (job.notification.smsPending) item.smsPk = 'PENDING#SMS';
  if (job.notification.digestPending) item.digestPk = 'PENDING#DIGEST';
  if (job.open && job.technical !== false) { item.openPk = 'OPEN'; item.openSk = `${job.firstSeenAt}#${job.jobId}`; }
  if (!job.open && job.technical !== false) { item.closedPk = 'CLOSED'; item.closedSk = `${job.lastSeenAt}#${job.jobId}`; }
  return item;
}

export class DynamoInternshipStore implements InternshipStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? createDynamoDocumentClient(); }
  private async queryAll(command: ConstructorParameters<typeof QueryCommand>[0]) {
    const items: Record<string, unknown>[] = []; let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({ ...command, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      items.push(...(response.Items ?? []) as Record<string, unknown>[]); cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'CHECKPOINT' } }));
    return result.Item?.checkpoint as SourceCheckpoint | undefined;
  }
  async putCheckpoint(checkpoint: SourceCheckpoint): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { pk: `SOURCE#${checkpoint.sourceId}`, sk: 'CHECKPOINT', checkpoint } }));
  }
  async getSourceOccurrences(sourceId: string): Promise<SourceOccurrenceState[]> {
    return (await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `SOURCE#${sourceId}`, ':prefix': 'OCCURRENCE#' },
    })).map((item) => item.occurrence as SourceOccurrenceState);
  }
  async putSourceOccurrence(occurrence: SourceOccurrenceState): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: `SOURCE#${occurrence.sourceId}`, sk: `OCCURRENCE#${occurrence.externalId}`, occurrence },
    }));
  }
  async getSourceHealth(sourceId: string): Promise<SourceHealth | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'HEALTH' } }));
    return result.Item?.health as SourceHealth | undefined;
  }
  async putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: internshipItem(job) } },
          {
            Put: {
              TableName: this.tableName,
              Item: { pk: `OUTBOX#${event.eventId}`, sk: 'EVENT', event },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name !== 'TransactionCanceledException') throw error;
      const existing = await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: { pk: `OUTBOX#${event.eventId}`, sk: 'EVENT' },
        ConsistentRead: true,
      }));
      if (existing.Item) return false;
      throw error;
    }
  }
  async getSourceHealthMany(sourceIds: string[]): Promise<SourceHealth[]> {
    const health: SourceHealth[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      let keys = sourceIds.slice(offset, offset + 100).map((sourceId) => ({ pk: `SOURCE#${sourceId}`, sk: 'HEALTH' }));
      do {
        const result = await this.client.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }));
        health.push(...((result.Responses?.[this.tableName] ?? []).map((item) => item.health as SourceHealth)));
        keys = result.UnprocessedKeys?.[this.tableName]?.Keys as typeof keys ?? [];
      } while (keys.length);
    }
    return health;
  }
  async putSourceHealth(health: SourceHealth): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { pk: `SOURCE#${health.sourceId}`, sk: 'HEALTH', health } }));
  }
  async getMonitoringChecklist(period: string): Promise<MonitoringChecklist | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: 'OPERATIONS#MONITORING', sk: `CHECKLIST#${period}` },
    }));
    return result.Item?.checklist as MonitoringChecklist | undefined;
  }
  async putMonitoringChecklist(checklist: MonitoringChecklist): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: 'OPERATIONS#MONITORING', sk: `CHECKLIST#${checklist.period}`, checklist },
    }));
  }
  private async find(index: 'urlIndex' | 'fingerprintIndex', attribute: 'urlPk' | 'fingerprintPk', value: string) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: index, KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': attribute }, ExpressionAttributeValues: { ':value': value }, Limit: 1 }));
    return result.Items?.[0]?.job as Internship | undefined;
  }
  findByUrl(url: string) { return this.find('urlIndex', 'urlPk', `URL#${url}`); }
  findByFingerprint(fingerprint: string) { return this.find('fingerprintIndex', 'fingerprintPk', `FP#${fingerprint}`); }
  async putInternship(job: Internship): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: internshipItem(job) }));
  }
  private async pending(index: 'pendingSmsIndex' | 'pendingDigestIndex', attribute: 'smsPk' | 'digestPk', value: string): Promise<Internship[]> {
    return (await this.queryAll({ TableName: this.tableName, IndexName: index, KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': attribute }, ExpressionAttributeValues: { ':value': value } })).map((item) => item.job as Internship);
  }
  pendingSms() { return this.pending('pendingSmsIndex', 'smsPk', 'PENDING#SMS'); }
  pendingDigest() { return this.pending('pendingDigestIndex', 'digestPk', 'PENDING#DIGEST'); }
  async markSmsSent(jobId: string, sentAt: string) { const job = await this.getJob(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; await this.putInternship(job); } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = await this.getJob(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; await this.putInternship(job); } } }
  async getJob(jobId: string): Promise<Internship | undefined> { const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `JOB#${jobId}`, sk: 'META' } })); return result.Item?.job ? withEmployerCategory(result.Item.job as Internship) : undefined; }
  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open'): Promise<{ jobs: Internship[]; cursor?: string }> {
    const open = status === 'open';
    // Past cycles are hidden after the index read, so a page can come back
    // short — which the feed already tolerates. Only an entirely empty page is
    // re-read, because a client reads that as the end of the feed.
    const jobs: Internship[] = [];
    let startKey: Record<string, unknown> | undefined = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) : undefined;
    do {
      const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: open ? 'openJobsIndex' : 'closedJobsIndex', KeyConditionExpression: open ? 'openPk = :status' : 'closedPk = :status', ExpressionAttributeValues: { ':status': open ? 'OPEN' : 'CLOSED' }, ScanIndexForward: false, Limit: limit, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
      for (const item of result.Items ?? []) {
        const job = item.job as Internship;
        if (!isPastSeason(job.season)) jobs.push(withEmployerCategory(job));
      }
      startKey = result.LastEvaluatedKey;
    } while (startKey && jobs.length === 0);
    return { jobs, ...(startKey ? { cursor: Buffer.from(JSON.stringify(startKey)).toString('base64url') } : {}) };
  }
  async listOpenSince(after: string, before: string): Promise<Internship[]> {
    const result = await this.queryAll({
      TableName: this.tableName,
      IndexName: 'openJobsIndex',
      KeyConditionExpression: 'openPk = :open AND openSk BETWEEN :after AND :before',
      ExpressionAttributeValues: {
        ':open': 'OPEN',
        // `openSk` ends in a job ID, so this excludes roles exactly at `after`
        // while including all roles whose firstSeenAt equals `before`.
        ':after': `${after}\uffff`,
        ':before': `${before}\uffff`,
      },
      ScanIndexForward: false,
    });
    return result
      .map((item) => item.job as Internship)
      .filter((job) => !isPastSeason(job.season))
      .map(withEmployerCategory);
  }
  async listLeverAdmissions(): Promise<LeverAdmission[]> {
    return (await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'REGISTRY#LEVER', ':prefix': 'SOURCE#' },
    })).map((item) => item.admission as LeverAdmission);
  }
  async putLeverAdmission(admission: LeverAdmission): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { pk: 'REGISTRY#LEVER', sk: `SOURCE#${admission.source.site}`, admission },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new Error(`Lever site ${admission.source.site} is already admitted`);
      }
      throw error;
    }
  }
}

export interface UserStore {
  getPreferences(userId: string): Promise<UserPreferences | undefined>;
  putPreferences(value: UserPreferences): Promise<void>;
  activeDevices(): Promise<DeviceToken[]>;
  putDevice(value: DeviceToken): Promise<void>;
  deleteDevice(userId: string, token: string): Promise<void>;
  getProfile(userId: string): Promise<ApplicantProfile | undefined>;
  putProfile(value: ApplicantProfile): Promise<void>;
  listApplications(userId: string): Promise<ApplicationRecord[]>;
  getApplication(userId: string, applicationId: string): Promise<ApplicationRecord | undefined>;
  putApplication(userId: string, value: ApplicationRecord): Promise<void>;
  getApplicationSession(userId: string, sessionId: string): Promise<ApplicationSession | undefined>;
  getApplicationSessionById(sessionId: string): Promise<ApplicationSession | undefined>;
  putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number): Promise<boolean>;
  listApplicationSessions(userId: string, applicationId?: string): Promise<ApplicationSession[]>;
  listDocuments(userId: string): Promise<UserDocument[]>;
  putDocument(value: UserDocument): Promise<void>;
  deleteDocument(userId: string, documentId: string): Promise<void>;
  getReceipt(userId: string, jobId: string, token: string): Promise<DeliveryReceipt | undefined>;
  putReceipt(value: DeliveryReceipt): Promise<void>;
  pendingReceipts(): Promise<DeliveryReceipt[]>;
  deleteUser(userId: string): Promise<UserDocument[]>;
}

export class MemoryUserStore implements UserStore {
  readonly preferences = new Map<string, UserPreferences>(); readonly devices = new Map<string, DeviceToken>(); readonly profiles = new Map<string, ApplicantProfile>(); readonly applications = new Map<string, ApplicationRecord>(); readonly sessions = new Map<string, ApplicationSession>(); readonly documents = new Map<string, UserDocument>(); readonly receipts = new Map<string, DeliveryReceipt>();
  async getPreferences(userId: string) { return this.preferences.get(userId); } async putPreferences(value: UserPreferences) { this.preferences.set(value.userId, structuredClone(value)); }
  async activeDevices() { return [...this.devices.values()].filter((d) => d.active).map((d) => structuredClone(d)); }
  async putDevice(value: DeviceToken) { this.devices.set(`${value.userId}#${value.token}`, structuredClone(value)); } async deleteDevice(userId: string, token: string) { this.devices.delete(`${userId}#${token}`); }
  async getProfile(userId: string) { return this.profiles.get(userId); } async putProfile(value: ApplicantProfile) { this.profiles.set(value.userId, structuredClone(value)); }
  async listApplications(userId: string) { return [...this.applications.entries()].filter(([key]) => key.startsWith(`${userId}#`)).map(([, value]) => value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => structuredClone(a)); }
  async getApplication(userId: string, applicationId: string) { const value = this.applications.get(`${userId}#${applicationId}`); return value && structuredClone(value); } async putApplication(userId: string, value: ApplicationRecord) { this.applications.set(`${userId}#${value.applicationId}`, structuredClone(value)); }
  async getApplicationSession(userId: string, sessionId: string) { const value = this.sessions.get(`${userId}#${sessionId}`); return value && structuredClone(value); }
  async getApplicationSessionById(sessionId: string) { const value = [...this.sessions.values()].find((session) => session.sessionId === sessionId); return value && structuredClone(value); }
  async putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number) { const key = `${userId}#${value.sessionId}`; const current = this.sessions.get(key); if (expectedVersion !== undefined && current?.version !== expectedVersion) return false; if (expectedVersion === undefined && current) return false; this.sessions.set(key, structuredClone(value)); return true; }
  async listApplicationSessions(userId: string, applicationId?: string) { return [...this.sessions.entries()].filter(([key, value]) => key.startsWith(`${userId}#`) && (!applicationId || value.applicationId === applicationId)).map(([, value]) => structuredClone(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listDocuments(userId: string) { return [...this.documents.values()].filter((d) => d.userId === userId).map((d) => structuredClone(d)); } async putDocument(value: UserDocument) { this.documents.set(`${value.userId}#${value.documentId}`, structuredClone(value)); } async deleteDocument(userId: string, documentId: string) { this.documents.delete(`${userId}#${documentId}`); }
  async getReceipt(userId: string, jobId: string, token: string) { return this.receipts.get(`${userId}#${jobId}#${token}`); } async putReceipt(value: DeliveryReceipt) { this.receipts.set(`${value.userId}#${value.jobId}#${value.token}`, structuredClone(value)); }
  async pendingReceipts() { return [...this.receipts.values()].filter((receipt) => receipt.status === 'pending' && receipt.ticketId).map((receipt) => structuredClone(receipt)); }
  async deleteUser(userId: string) { const docs = await this.listDocuments(userId); for (const map of [this.preferences, this.profiles]) map.delete(userId); for (const [key] of this.devices) if (key.startsWith(`${userId}#`)) this.devices.delete(key); for (const [key] of this.applications) if (key.startsWith(`${userId}#`)) this.applications.delete(key); for (const [key] of this.sessions) if (key.startsWith(`${userId}#`)) this.sessions.delete(key); for (const [key] of this.documents) if (key.startsWith(`${userId}#`)) this.documents.delete(key); for (const [key] of this.receipts) if (key.startsWith(`${userId}#`)) this.receipts.delete(key); return docs; }
}

type UserItem = { pk: string; sk: string; kind: string; value: unknown; activePk?: string; tokenPk?: string; receiptPk?: string; activeSessionPk?: string; expiresAtEpoch?: number };
export class DynamoUserStore implements UserStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? createDynamoDocumentClient(); }
  private async queryAll(command: ConstructorParameters<typeof QueryCommand>[0]) {
    const items: Record<string, unknown>[] = []; let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({ ...command, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      items.push(...(response.Items ?? []) as Record<string, unknown>[]); cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  private async get<T>(userId: string, sk: string) { return (await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk } }))).Item?.value as T | undefined; }
  private async put(userId: string, sk: string, kind: string, value: unknown, extra: Partial<UserItem> = {}) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { pk: `USER#${userId}`, sk, kind, value, ...extra } })); }
  getPreferences(userId: string) { return this.get<UserPreferences>(userId, 'PREFERENCES'); } putPreferences(value: UserPreferences) { return this.put(value.userId, 'PREFERENCES', 'preferences', value); }
  async activeDevices() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'activeDevicesIndex', KeyConditionExpression: 'activePk = :active', ExpressionAttributeValues: { ':active': 'ACTIVE' } })).map((item) => item.value as DeviceToken); }
  putDevice(value: DeviceToken) { return this.put(value.userId, `DEVICE#${value.token}`, 'device', value, value.active ? { activePk: 'ACTIVE', tokenPk: `TOKEN#${value.token}` } : { tokenPk: `TOKEN#${value.token}` }); } async deleteDevice(userId: string, token: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `DEVICE#${token}` } })); }
  getProfile(userId: string) { return this.get<ApplicantProfile>(userId, 'PROFILE'); } putProfile(value: ApplicantProfile) { return this.put(value.userId, 'PROFILE', 'profile', value); }
  async listApplications(userId: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'APPLICATION#' } })).map((item) => item.value as ApplicationRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  getApplication(userId: string, applicationId: string) { return this.get<ApplicationRecord>(userId, `APPLICATION#${applicationId}`); } putApplication(userId: string, value: ApplicationRecord) { return this.put(userId, `APPLICATION#${value.applicationId}`, 'application', value); }
  getApplicationSession(userId: string, sessionId: string) { return this.get<ApplicationSession>(userId, `APPLICATION_SESSION#${sessionId}`); }
  async getApplicationSessionById(sessionId: string) {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: 'activeSessionsIndex', KeyConditionExpression: 'activeSessionPk = :pk', ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}` }, Limit: 1 }));
    return response.Items?.[0]?.value as ApplicationSession | undefined;
  }
  async putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number) {
    const active = !['submitted', 'failed', 'cancelled'].includes(value.status);
    const input = {
      TableName: this.tableName,
      Item: {
        pk: `USER#${userId}`,
        sk: `APPLICATION_SESSION#${value.sessionId}`,
        kind: 'application-session',
        value,
        ...(active ? { activeSessionPk: `SESSION#${value.sessionId}` } : {}),
        expiresAtEpoch: Math.floor(new Date(value.metadataExpiresAt).getTime() / 1000),
      } satisfies UserItem,
      ...(expectedVersion === undefined
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: '#value.#version = :expectedVersion', ExpressionAttributeNames: { '#value': 'value', '#version': 'version' }, ExpressionAttributeValues: { ':expectedVersion': expectedVersion } }),
    };
    try { await this.client.send(new PutCommand(input)); return true; } catch (error) { if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false; throw error; }
  }
  async listApplicationSessions(userId: string, applicationId?: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'APPLICATION_SESSION#' } })).map((item) => item.value as ApplicationSession).filter((session) => !applicationId || session.applicationId === applicationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listDocuments(userId: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'DOCUMENT#' } })).map((item) => item.value as UserDocument); } putDocument(value: UserDocument) { return this.put(value.userId, `DOCUMENT#${value.documentId}`, 'document', value); } async deleteDocument(userId: string, documentId: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `DOCUMENT#${documentId}` } })); }
  getReceipt(userId: string, jobId: string, token: string) { return this.get<DeliveryReceipt>(userId, `RECEIPT#${jobId}#${token}`); } putReceipt(value: DeliveryReceipt) { return this.put(value.userId, `RECEIPT#${value.jobId}#${value.token}`, 'receipt', value, value.status === 'pending' ? { receiptPk: 'PENDING' } : {}); }
  async pendingReceipts() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'pendingReceiptsIndex', KeyConditionExpression: 'receiptPk = :pending', ExpressionAttributeValues: { ':pending': 'PENDING' } })).map((item) => item.value as DeliveryReceipt); }
  async deleteUser(userId: string) { const documents = await this.listDocuments(userId); const items = await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `USER#${userId}` } }); await Promise.all(items.map((item) => this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: item.pk, sk: item.sk } })))); return documents; }
}
