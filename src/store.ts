import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Internship, SourceCheckpoint } from './types.js';

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
}

type JobItem = { pk: string; sk: 'META'; urlPk: string; fingerprintPk: string; smsPk?: string; digestPk?: string; job: Internship };

export class DynamoInternshipStore implements InternshipStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({})); }
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
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }
  private async pending(index: 'pendingSmsIndex' | 'pendingDigestIndex', attribute: 'smsPk' | 'digestPk', value: string): Promise<Internship[]> {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: index, KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': attribute }, ExpressionAttributeValues: { ':value': value } }));
    return (result.Items ?? []).map((item) => item.job as Internship);
  }
  pendingSms() { return this.pending('pendingSmsIndex', 'smsPk', 'PENDING#SMS'); }
  pendingDigest() { return this.pending('pendingDigestIndex', 'digestPk', 'PENDING#DIGEST'); }
  async markSmsSent(jobId: string, sentAt: string) { const job = await this.getJob(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; await this.putInternship(job); } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = await this.getJob(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; await this.putInternship(job); } } }
  private async getJob(jobId: string): Promise<Internship | undefined> { const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `JOB#${jobId}`, sk: 'META' } })); return result.Item?.job as Internship | undefined; }
}
