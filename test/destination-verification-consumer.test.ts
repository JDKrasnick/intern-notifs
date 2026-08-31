import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { enqueueDueDestinationVerifications, processDestinationVerificationBatch, sendAdmissionOperationalAlert,
  type DestinationVerificationEnvironment,
  type DestinationVerificationMessage } from '../cloudflare/destination-verification.js';
import type { D1Database, D1PreparedStatement, MessageBatch, QueueMessage } from '../cloudflare/types.js';
import type { Internship, SourceOccurrence } from '../src/types.js';

const launch = vi.hoisted(() => vi.fn());
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch } }));

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return database.prepare(query).get(...values) as T | null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function subject() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0008_catalog_admission_occurrence_repair.sql',
    '0010_posting_identity.sql',
    '0011_destination_verification_schedule.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, db, operations: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

function role(): { job: Internship; reference: SourceOccurrence } {
  const reference: SourceOccurrence = {
    sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '7654321', document: '7654321',
    sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme',
    title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', compensation: { raw: '' }, state: 'open',
  };
  return { reference, job: {
    jobId: 'job-1', company: reference.company, title: reference.title, location: reference.location, season: reference.season,
    applyUrl: reference.applyUrl, normalizedUrl: reference.applyUrl, fingerprint: 'fingerprint', compensation: { raw: '' },
    sourceReferences: [reference], technical: true, open: true, firstSeenAt: '2026-08-01T00:00:00Z',
    catalogVisibleAt: '2026-08-01T00:00:00Z', catalogRecency: 'normal', lastSeenAt: '2026-08-30T00:00:00Z',
    notification: { smsPending: false, digestPending: false },
  } };
}

function queueMessage(body: DestinationVerificationMessage) {
  return { id: 'message-1', body, ack: vi.fn(), retry: vi.fn() } satisfies QueueMessage<DestinationVerificationMessage>;
}

function environment(db: D1Database): DestinationVerificationEnvironment {
  return {
    DB: db, DESTINATION_BROWSER: {} as DestinationVerificationEnvironment['DESTINATION_BROWSER'],
    DESTINATION_VERIFICATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
  };
}

describe('destination verification queue consumer', () => {
  beforeEach(() => launch.mockReset());

  it('acknowledges a duplicate completion without opening a page or mutating state', async () => {
    const { db, operations } = subject();
    await operations.recordVerificationCompletion('already-complete', '2026-08-30T00:00:00Z');
    const newPage = vi.fn();
    launch.mockResolvedValue({ newPage, close: vi.fn() });
    const { reference } = role();
    const queued = queueMessage({ version: 1, jobId: 'job-1', sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'already-complete' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(newPage).not.toHaveBeenCalled();
  });

  it('discards a live message when the occurrence URL and posting identity have changed', async () => {
    const { db, jobs } = subject();
    const { job, reference } = role();
    const currentReference = { ...reference, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/8765432' };
    await jobs.putInternship({ ...job, applyUrl: currentReference.applyUrl, normalizedUrl: currentReference.applyUrl,
      sourceReferences: [currentReference] });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'stale-generation' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(await jobs.getJob(job.jobId)).toMatchObject({ applyUrl: currentReference.applyUrl,
      sourceReferences: [{ applyUrl: currentReference.applyUrl }] });
  });

  it('does not persist evidence when the occurrence changes while the browser is running', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    const changedReference = { ...reference, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/8765432' };
    const frame = { evaluate: vi.fn().mockResolvedValue({ url: reference.applyUrl, title: reference.title,
      visibleText: `${reference.title} ${reference.externalId} Apply`,
      structuredJobText: JSON.stringify({ '@type': 'JobPosting', identifier: reference.externalId, title: reference.title }),
      jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }), parentFrame: () => null };
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockImplementation(async () => {
        await jobs.putInternship({ ...job, applyUrl: changedReference.applyUrl, normalizedUrl: changedReference.applyUrl,
          sourceReferences: [changedReference] });
        return { status: () => 200 };
      }),
      frames: () => [frame], close: vi.fn(),
    }), close: vi.fn() });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'raced-generation' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    const stored = await jobs.getJob(job.jobId);
    expect(stored).toMatchObject({ applyUrl: changedReference.applyUrl,
      sourceReferences: [{ applyUrl: changedReference.applyUrl }] });
    expect(stored?.sourceReferences[0]).not.toHaveProperty('admission');
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_evidence').get()).toEqual({ count: 0 });
  });

  it('keeps historical evidence out of live evidence and catalog state', async () => {
    const { database, db, operations, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    const before = await jobs.getJob(job.jobId);
    const generation = await operations.previewBackfill('2026-08-30T00:00:00Z');
    const [candidate] = await operations.backfillPage(generation.id);
    await operations.markBackfillQueued(generation.id, [candidate!.occurrenceKey], '2026-08-30T00:01:00Z');
    const frame = { evaluate: vi.fn().mockResolvedValue({ url: reference.applyUrl, title: reference.title,
      visibleText: `${reference.externalId} Responsibilities and qualifications. ${'Build reliable systems. '.repeat(30)}`,
      structuredJobText: JSON.stringify({ '@type': 'JobPosting', identifier: reference.externalId, description: reference.title }),
      jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }), parentFrame: () => null };
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue({ status: () => 200 }), frames: () => [frame], close: vi.fn(),
    }), close: vi.fn() });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: candidate!.providerIdentity,
      reason: 'historical-backfill', queuedAt: '2026-08-30T00:01:00Z', generationId: generation.id,
      occurrenceKey: candidate!.occurrenceKey });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] } as MessageBatch<unknown>,
      environment(db), () => new Date('2026-08-30T00:02:00Z'));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(await jobs.getJob(job.jobId)).toEqual(before);
    expect(database.prepare('SELECT count(*) AS count FROM admission_backfill_evidence').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_evidence').get()).toEqual({ count: 0 });
  });

  it('retries a transient browser failure for platform retry and eventual DLQ handling', async () => {
    const { db, operations, jobs } = subject();
    const { job, reference } = role();
    const priorAdmission = {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved' as const,
      postingAttribution: 'attributed' as const,
      destination: { classification: 'posting-detail' as const, candidateUrl: reference.applyUrl,
        provider: 'greenhouse' as const, tenant: 'acme', expectedPostingId: reference.externalId,
        inspectedAt: '2026-08-24T00:00:00Z', freshUntil: '2026-08-31T00:00:00Z', nextCheckAt: '2026-08-30T00:00:00Z' },
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: '2026-08-24T00:00:00Z',
      evidenceObservedAt: '2026-08-24T00:00:00Z',
    };
    reference.admission = priorAdmission;
    job.admission = priorAdmission;
    await jobs.putInternship({ ...job, sourceReferences: [reference] });
    await operations.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const [scheduled] = await operations.leaseDueVerifications('2026-08-30T00:00:00Z');
    expect(scheduled).toBeDefined();
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockRejectedValue(new Error('timeout')), frames: () => [], close: vi.fn(),
    }), close: vi.fn() });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: scheduled!.providerIdentity,
      reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', occurrenceKey: scheduled!.occurrenceKey,
      leaseToken: scheduled!.leaseToken, idempotencyKey: 'scheduled-generation' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 86_400 });
    expect(queued.ack).not.toHaveBeenCalled();

    const queue = { send: vi.fn(), sendBatch: vi.fn() };
    await expect(enqueueDueDestinationVerifications({ ...environment(db), DESTINATION_VERIFICATION_QUEUE: queue },
      new Date('2026-08-31T00:01:00Z'), { syncSchedule: false })).resolves.toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
    await expect(enqueueDueDestinationVerifications({ ...environment(db), DESTINATION_VERIFICATION_QUEUE: queue },
      new Date('2026-08-31T01:02:00Z'), { syncSchedule: false })).resolves.toBe(1);
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it('uses the configured verified sender for operational alerts', async () => {
    const { operations } = subject();
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', send);
    const sent = await sendAdmissionOperationalAlert(operations, {
      RESEND_API_KEY: 'resend-key', ADMISSION_SUPPORT_RECIPIENT: 'support@example.test',
      AUTH_FROM_EMAIL: 'InternNotifs <notifications@send.internnotifs.app>',
    }, { signals: ['destination-verification-dlq'], details: 'One message is waiting.', observedAt: '2026-08-30T12:00:00Z' });
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const init = send.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: 'InternNotifs <notifications@send.internnotifs.app>',
      to: ['support@example.test'],
    });
    vi.unstubAllGlobals();
  });
});
