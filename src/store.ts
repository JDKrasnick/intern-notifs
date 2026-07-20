import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isTechnicalJob } from './core/filters.js';
import { employerCategory } from './core/employers.js';
import type { ApplicantProfile, ApplicationRecord, DeliveryReceipt, DeviceToken, Internship, SourceCheckpoint, UserDocument, UserPreferences } from './types.js';

function withEmployerCategory(job: Internship): Internship {
  return { ...structuredClone(job), employerCategory: job.employerCategory ?? employerCategory(job.company) };
}

export interface InternshipStore {
  getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined>;
  putCheckpoint(checkpoint: SourceCheckpoint): Promise<void>;
  findByUrl(url: string): Promise<Internship | undefined>;
  findByFingerprint(fingerprint: string): Promise<Internship | undefined>;
  putInternship(job: Internship): Promise<void>;
  pendingSms(): Promise<Internship[]>;
  pendingDigest(): Promise<Internship[]>;
  markSmsSent(jobIds: string, sentAt: string): Promise<void>;
  markDigested(jobIds: string[], sentAt: string): Promise<void>;
  getJob?(jobId: string): Promise<Internship | undefined>;
  listOpen?(cursor?: string, limit?: number, status?: 'open' | 'closed'): Promise<{ jobs: Internship[]; cursor?: string }>;
}

export class MemoryInternshipStore implements InternshipStore {
  readonly jobs = new Map<string, Internship>();
  readonly checkpoints = new Map<string, SourceCheckpoint>();
  async getCheckpoint(sourceId: string) { return this.checkpoints.get(sourceId); }
  async putCheckpoint(checkpoint: SourceCheckpoint) { this.checkpoints.set(checkpoint.sourceId, checkpoint); }
  async findByUrl(url: string) { return [...this.jobs.values()].find((job) => job.normalizedUrl === url); }
  async findByFingerprint(fingerprint: string) { return [...this.jobs.values()].find((job) => job.fingerprint === fingerprint); }
  async putInternship(job: Internship) { this.jobs.set(job.jobId, structuredClone(job)); }
  async pendingSms() { return [...this.jobs.values()].filter((job) => job.notification.smsPending && job.open); }
  async pendingDigest() { return [...this.jobs.values()].filter((job) => job.notification.digestPending && job.open); }
  async markSmsSent(jobId: string, sentAt: string) { const job = this.jobs.get(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = this.jobs.get(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; } } }
  async getJob(jobId: string) { const job = this.jobs.get(jobId); return job && withEmployerCategory(job); }
  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open') { const jobs = [...this.jobs.values()].filter((job) => job.open === (status === 'open') && isTechnicalJob(job)).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)); const offset = cursor ? Number(cursor) : 0; const page = jobs.slice(offset, offset + limit).map(withEmployerCategory); return { jobs: page, cursor: offset + page.length < jobs.length ? String(offset + page.length) : undefined }; }
}

type JobItem = { pk: string; sk: 'META'; urlPk: string; fingerprintPk: string; smsPk?: string; digestPk?: string; openPk?: string; openSk?: string; closedPk?: string; closedSk?: string; job: Internship };

export class DynamoInternshipStore implements InternshipStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({})); }
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
  private async find(index: 'urlIndex' | 'fingerprintIndex', attribute: 'urlPk' | 'fingerprintPk', value: string) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: index, KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': attribute }, ExpressionAttributeValues: { ':value': value }, Limit: 1 }));
    return result.Items?.[0]?.job as Internship | undefined;
  }
  findByUrl(url: string) { return this.find('urlIndex', 'urlPk', `URL#${url}`); }
  findByFingerprint(fingerprint: string) { return this.find('fingerprintIndex', 'fingerprintPk', `FP#${fingerprint}`); }
  async putInternship(job: Internship): Promise<void> {
    const item: JobItem = { pk: `JOB#${job.jobId}`, sk: 'META', urlPk: `URL#${job.normalizedUrl}`, fingerprintPk: `FP#${job.fingerprint}`, job };
    if (job.notification.smsPending) item.smsPk = 'PENDING#SMS';
    if (job.notification.digestPending) item.digestPk = 'PENDING#DIGEST';
    if (job.open && isTechnicalJob(job)) { item.openPk = 'OPEN'; item.openSk = `${job.firstSeenAt}#${job.jobId}`; }
    if (!job.open && isTechnicalJob(job)) { item.closedPk = 'CLOSED'; item.closedSk = `${job.lastSeenAt}#${job.jobId}`; }
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
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
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: open ? 'openJobsIndex' : 'closedJobsIndex', KeyConditionExpression: open ? 'openPk = :status' : 'closedPk = :status', ExpressionAttributeValues: { ':status': open ? 'OPEN' : 'CLOSED' }, ScanIndexForward: false, Limit: limit, ...(cursor ? { ExclusiveStartKey: JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } : {}) }));
    return { jobs: (result.Items ?? []).map((item) => withEmployerCategory(item.job as Internship)), ...(result.LastEvaluatedKey ? { cursor: Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') } : {}) };
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
  listDocuments(userId: string): Promise<UserDocument[]>;
  putDocument(value: UserDocument): Promise<void>;
  deleteDocument(userId: string, documentId: string): Promise<void>;
  getReceipt(userId: string, jobId: string, token: string): Promise<DeliveryReceipt | undefined>;
  putReceipt(value: DeliveryReceipt): Promise<void>;
  pendingReceipts(): Promise<DeliveryReceipt[]>;
  deleteUser(userId: string): Promise<UserDocument[]>;
}

export class MemoryUserStore implements UserStore {
  readonly preferences = new Map<string, UserPreferences>(); readonly devices = new Map<string, DeviceToken>(); readonly profiles = new Map<string, ApplicantProfile>(); readonly applications = new Map<string, ApplicationRecord>(); readonly documents = new Map<string, UserDocument>(); readonly receipts = new Map<string, DeliveryReceipt>();
  async getPreferences(userId: string) { return this.preferences.get(userId); } async putPreferences(value: UserPreferences) { this.preferences.set(value.userId, structuredClone(value)); }
  async activeDevices() { return [...this.devices.values()].filter((d) => d.active).map((d) => structuredClone(d)); }
  async putDevice(value: DeviceToken) { this.devices.set(`${value.userId}#${value.token}`, structuredClone(value)); } async deleteDevice(userId: string, token: string) { this.devices.delete(`${userId}#${token}`); }
  async getProfile(userId: string) { return this.profiles.get(userId); } async putProfile(value: ApplicantProfile) { this.profiles.set(value.userId, structuredClone(value)); }
  async listApplications(userId: string) { return [...this.applications.entries()].filter(([key]) => key.startsWith(`${userId}#`)).map(([, value]) => value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => structuredClone(a)); }
  async getApplication(userId: string, applicationId: string) { const value = this.applications.get(`${userId}#${applicationId}`); return value && structuredClone(value); } async putApplication(userId: string, value: ApplicationRecord) { this.applications.set(`${userId}#${value.applicationId}`, structuredClone(value)); }
  async listDocuments(userId: string) { return [...this.documents.values()].filter((d) => d.userId === userId).map((d) => structuredClone(d)); } async putDocument(value: UserDocument) { this.documents.set(`${value.userId}#${value.documentId}`, structuredClone(value)); } async deleteDocument(userId: string, documentId: string) { this.documents.delete(`${userId}#${documentId}`); }
  async getReceipt(userId: string, jobId: string, token: string) { return this.receipts.get(`${userId}#${jobId}#${token}`); } async putReceipt(value: DeliveryReceipt) { this.receipts.set(`${value.userId}#${value.jobId}#${value.token}`, structuredClone(value)); }
  async pendingReceipts() { return [...this.receipts.values()].filter((receipt) => receipt.status === 'pending' && receipt.ticketId).map((receipt) => structuredClone(receipt)); }
  async deleteUser(userId: string) { const docs = await this.listDocuments(userId); for (const map of [this.preferences, this.profiles]) map.delete(userId); for (const [key] of this.devices) if (key.startsWith(`${userId}#`)) this.devices.delete(key); for (const [key] of this.applications) if (key.startsWith(`${userId}#`)) this.applications.delete(key); for (const [key] of this.documents) if (key.startsWith(`${userId}#`)) this.documents.delete(key); for (const [key] of this.receipts) if (key.startsWith(`${userId}#`)) this.receipts.delete(key); return docs; }
}

type UserItem = { pk: string; sk: string; kind: string; value: unknown; activePk?: string; tokenPk?: string; receiptPk?: string };
export class DynamoUserStore implements UserStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({})); }
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
  async listDocuments(userId: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'DOCUMENT#' } })).map((item) => item.value as UserDocument); } putDocument(value: UserDocument) { return this.put(value.userId, `DOCUMENT#${value.documentId}`, 'document', value); } async deleteDocument(userId: string, documentId: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `DOCUMENT#${documentId}` } })); }
  getReceipt(userId: string, jobId: string, token: string) { return this.get<DeliveryReceipt>(userId, `RECEIPT#${jobId}#${token}`); } putReceipt(value: DeliveryReceipt) { return this.put(value.userId, `RECEIPT#${value.jobId}#${value.token}`, 'receipt', value, value.status === 'pending' ? { receiptPk: 'PENDING' } : {}); }
  async pendingReceipts() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'pendingReceiptsIndex', KeyConditionExpression: 'receiptPk = :pending', ExpressionAttributeValues: { ':pending': 'PENDING' } })).map((item) => item.value as DeliveryReceipt); }
  async deleteUser(userId: string) { const documents = await this.listDocuments(userId); const items = await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `USER#${userId}` } }); await Promise.all(items.map((item) => this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: item.pk, sk: item.sk } })))); return documents; }
}
