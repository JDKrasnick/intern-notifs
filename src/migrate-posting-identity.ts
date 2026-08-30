import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ApplicationSession } from './application-automation.js';
import { mergeSourceOccurrenceReferences } from './identity/source-occurrence.js';
import { providerEvidenceForOccurrence } from './identity/reviewed-provider.js';
import { resolvePostingIdentityDecision } from './identity/registry.js';
import { notificationDedupeKey } from './notifications.js';
import { createDynamoDocumentClient, DynamoInternshipStore, DynamoUserStore } from './store.js';
import type { ApplicationRecord, DeliveryReceipt, Internship, PostingAlias, PostingIdentity, UserPreferences } from './types.js';

type JobItem = { pk?: string; sk?: string; job?: Internship; occurrence?: { jobId: string } };
type ReceiptItem = { kind?: string; value?: DeliveryReceipt };
type UserValueItem<T> = { pk: string; sk: string; kind?: string; value: T };
export type MigrationApplication = { userId: string; application: ApplicationRecord; pk: string; sk: string };
export type MigrationApplicationSession = { userId: string; session: ApplicationSession; pk: string; sk: string };

export interface PostingIdentityMigrationReport {
  openJobs: number;
  receiptRows: number;
  referencedJobs: number;
  identityClaims: number;
  jobUpdates: number;
  duplicateOpenJobs: number;
  occurrenceRemaps: number;
  receiptCopies: number;
  applicationRows: number;
  applicationRemaps: number;
  applicationMerges: number;
  applicationSessionRemaps: number;
  activeAlertPreferences: number;
  conflicts: string[];
  repairToken: string;
  applied: boolean;
}

type MigrationPlan = PostingIdentityMigrationReport & {
  updates: Internship[];
  aliases: Array<{ identity: PostingIdentity; canonicalJobId: string }>;
  duplicateIds: string[];
  canonicalByJobId: Map<string, string>;
  receipts: Array<{ receipt: DeliveryReceipt; dedupeKey: string; canonicalJobId: string }>;
  applications: ApplicationMigrationPlan;
};

export type ApplicationMigrationPlan = {
  writes: Array<{ pk: string; sk: string; application: ApplicationRecord; expectedUpdatedAt: string }>;
  deletes: Array<{ pk: string; sk: string; applicationId: string; expectedUpdatedAt: string }>;
  sessionWrites: Array<{ pk: string; sk: string; session: ApplicationSession }>;
};

function first(value: Internship) { return value.firstSeenAt || value.lastSeenAt; }
function earliest(values: string[]) { return [...values].sort()[0]!; }
function latest(values: string[]) { return [...values].sort().at(-1)!; }

function mergedJob(canonical: Internship, jobs: Internship[], identity: PostingIdentity): Internship {
  const references = mergeSourceOccurrenceReferences(jobs.flatMap((job) => job.sourceReferences));
  return {
    ...canonical,
    postingIdentity: identity,
    sourceReferences: references,
    open: jobs.some((job) => job.open),
    technical: jobs.some((job) => job.technical !== false),
    firstSeenAt: earliest(jobs.map(first)),
    catalogVisibleAt: earliest(jobs.map((job) => job.catalogVisibleAt ?? first(job))),
    lastSeenAt: latest(jobs.map((job) => job.lastSeenAt)),
    notification: {
      smsPending: jobs.some((job) => job.notification.smsPending),
      digestPending: jobs.some((job) => job.notification.digestPending),
      ...(jobs.map((job) => job.notification.smsSentAt).filter((value): value is string => Boolean(value)).sort().at(-1) ? { smsSentAt: jobs.map((job) => job.notification.smsSentAt).filter((value): value is string => Boolean(value)).sort().at(-1) } : {}),
      ...(jobs.map((job) => job.notification.digestedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ? { digestedAt: jobs.map((job) => job.notification.digestedAt).filter((value): value is string => Boolean(value)).sort().at(-1) } : {}),
    },
  };
}

function unionAliases(identities: PostingIdentity[], canonicalJobId: string): PostingIdentity {
  const aliases = [...new Map(identities.flatMap((identity) => identity.aliases)
    .map((alias) => [`${alias.kind}\0${alias.value}`, alias] as const)).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
  const representative = identities.find((identity) => identity.providerPostingId) ?? identities[0]!;
  return { ...representative, aliases, canonicalJobId };
}

function userIdFromPk(pk: string) { return pk.startsWith('USER#') ? pk.slice('USER#'.length) : ''; }

function mergedNotes(applications: ApplicationRecord[]) {
  const notes = [...new Set([...applications]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.applicationId.localeCompare(right.applicationId))
    .map((application) => application.notes?.trim()).filter((note): note is string => Boolean(note)))];
  return notes.length ? notes.join('\n\n') : undefined;
}

function applicationStatusRank(status: ApplicationRecord['status']) {
  return status === 'saved' ? 0
    : status === 'applied' ? 1
      : status === 'assessment' ? 2
        : status === 'interview' ? 3
          : 4;
}

function receiptRank(receipt: DeliveryReceipt) {
  if (receipt.status === 'ok' || receipt.deliveryState === 'delivered') return 5;
  if (receipt.deliveryState === 'accepted' || receipt.deliveryState === 'unknown' || receipt.status === 'pending') return 4;
  if (receipt.deliveryState === 'definitive-failure') return 3;
  if (receipt.status === 'retryable') return 2;
  return 1;
}

function migrationIdentity(job: Internship): PostingIdentity | undefined {
  const urls = [job.applyUrl, ...job.sourceReferences.map((reference) => reference.applyUrl)];
  const providerEvidence = job.sourceReferences.map((reference) => reference.providerEvidence
    ?? (reference.externalId ? providerEvidenceForOccurrence(reference.sourceId, reference.externalId, [reference.applyUrl]) : undefined))
    .find((value) => value !== undefined);
  const reference = job.sourceReferences.find((item) => item.providerEvidence === providerEvidence) ?? job.sourceReferences[0];
  const result = resolvePostingIdentityDecision({
    sourceId: reference?.sourceId ?? 'legacy-dynamo-migration',
    externalId: reference?.externalId ?? job.jobId,
    applicationUrl: job.applyUrl,
    observedUrls: urls,
    observedAt: job.lastSeenAt,
    ...(providerEvidence ? { providerEvidence } : {}),
  });
  return result.decision.status === 'confirmed' ? result.identity : undefined;
}

export function planApplicationIdentityMigration(
  applications: MigrationApplication[],
  sessions: MigrationApplicationSession[],
  canonicalByJobId: Map<string, string>,
): ApplicationMigrationPlan {
  const groups = new Map<string, MigrationApplication[]>();
  for (const item of applications) {
    const canonicalJobId = canonicalByJobId.get(item.application.jobId);
    if (!canonicalJobId) continue;
    const key = `${item.userId}\0${canonicalJobId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const writes: ApplicationMigrationPlan['writes'] = [];
  const deletes: ApplicationMigrationPlan['deletes'] = [];
  const canonicalApplicationId = new Map<string, string>();
  for (const members of groups.values()) {
    const canonicalJobId = canonicalByJobId.get(members[0]!.application.jobId)!;
    if (members.every((member) => member.application.jobId === canonicalJobId)) continue;
    const ordered = [...members].sort((left, right) =>
      right.application.updatedAt.localeCompare(left.application.updatedAt)
      || left.application.applicationId.localeCompare(right.application.applicationId));
    const keeper = ordered[0]!;
    const status = [...ordered].sort((left, right) =>
      applicationStatusRank(right.application.status) - applicationStatusRank(left.application.status)
      || right.application.updatedAt.localeCompare(left.application.updatedAt)
      || left.application.applicationId.localeCompare(right.application.applicationId))[0]!.application.status;
    const notes = mergedNotes(ordered.map((item) => item.application));
    const application: ApplicationRecord = {
      ...keeper.application,
      jobId: canonicalJobId,
      status,
      createdAt: earliest(ordered.map((item) => item.application.createdAt)),
      updatedAt: latest(ordered.map((item) => item.application.updatedAt)),
      ...(notes ? { notes } : { notes: undefined }),
    };
    writes.push({ pk: keeper.pk, sk: keeper.sk, application, expectedUpdatedAt: keeper.application.updatedAt });
    for (const member of ordered) canonicalApplicationId.set(`${member.userId}\0${member.application.applicationId}`, application.applicationId);
    deletes.push(...ordered.slice(1).map(({ pk, sk, application: value }) => ({
      pk, sk, applicationId: value.applicationId, expectedUpdatedAt: value.updatedAt,
    })));
  }

  const sessionWrites = sessions.flatMap(({ userId, session, pk, sk }) => {
    const jobId = canonicalByJobId.get(session.jobId) ?? session.jobId;
    const applicationId = canonicalApplicationId.get(`${userId}\0${session.applicationId}`) ?? session.applicationId;
    if (jobId === session.jobId && applicationId === session.applicationId) return [];
    return [{ pk, sk, session: { ...session, jobId, applicationId } }];
  });
  return { writes, deletes, sessionWrites };
}

export function planPostingIdentityMigration(
  jobs: Internship[],
  receipts: DeliveryReceipt[],
  applications: MigrationApplication[] = [],
  sessions: MigrationApplicationSession[] = [],
): MigrationPlan {
  const receiptJobIds = new Set(receipts.map((receipt) => receipt.jobId));
  const selected = jobs.filter((job) => job.open || receiptJobIds.has(job.jobId));
  const conflicts: string[] = [];
  const identities = new Map<string, PostingIdentity>();
  for (const job of selected) {
    try {
      const identity = migrationIdentity(job);
      if (identity) identities.set(job.jobId, identity);
    }
    catch (error) { conflicts.push(`${job.jobId}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const parent = new Map([...identities.keys()].map((jobId) => [jobId, jobId]));
  const root = (jobId: string): string => {
    const next = parent.get(jobId)!;
    if (next === jobId) return jobId;
    const resolved = root(next); parent.set(jobId, resolved); return resolved;
  };
  const join = (left: string, right: string) => { const a = root(left); const b = root(right); if (a !== b) parent.set(b, a); };
  const owner = new Map<string, string>();
  for (const [jobId, identity] of identities) for (const alias of identity.aliases) {
    const prior = owner.get(alias.value);
    if (prior) join(jobId, prior); else owner.set(alias.value, jobId);
  }
  const groups = new Map<string, Internship[]>();
  for (const job of selected.filter((candidate) => identities.has(candidate.jobId))) {
    const key = root(job.jobId); groups.set(key, [...(groups.get(key) ?? []), job]);
  }

  const updates: Internship[] = [];
  const aliases: MigrationPlan['aliases'] = [];
  const duplicateIds: string[] = [];
  const canonicalByJobId = new Map<string, string>();
  const canonicalJobs = new Map<string, Internship>();
  for (const members of groups.values()) {
    const ordered = [...members].sort((left, right) => first(left).localeCompare(first(right)) || left.jobId.localeCompare(right.jobId));
    const canonical = ordered[0]!;
    const canonicalIdentity = unionAliases(ordered.map((job) => identities.get(job.jobId)!), canonical.jobId);
    const openMembers = ordered.filter((job) => job.open);
    const update = openMembers.length ? mergedJob(canonical, ordered, canonicalIdentity) : { ...canonical, postingIdentity: canonicalIdentity };
    updates.push(update); canonicalJobs.set(canonical.jobId, update);
    for (const member of ordered) canonicalByJobId.set(member.jobId, canonical.jobId);
    for (const identity of ordered.map((job) => identities.get(job.jobId)!)) aliases.push({ identity: { ...identity, canonicalJobId: canonical.jobId }, canonicalJobId: canonical.jobId });
    duplicateIds.push(...openMembers.filter((job) => job.jobId !== canonical.jobId).map((job) => job.jobId));
  }

  const rawReceiptCopies = receipts.flatMap((receipt) => {
    const canonicalJobId = canonicalByJobId.get(receipt.jobId);
    const canonical = canonicalJobId && canonicalJobs.get(canonicalJobId);
    if (!canonicalJobId || !canonical) return [];
    return [{ receipt, canonicalJobId, dedupeKey: notificationDedupeKey(canonical) }];
  });
  const receiptCopyByKey = new Map<string, (typeof rawReceiptCopies)[number]>();
  for (const copy of rawReceiptCopies) {
    const key = `${copy.receipt.userId}\0${copy.dedupeKey}\0${copy.receipt.token}`;
    const prior = receiptCopyByKey.get(key);
    if (!prior
      || receiptRank(copy.receipt) > receiptRank(prior.receipt)
      || (receiptRank(copy.receipt) === receiptRank(prior.receipt)
        && (copy.receipt.updatedAt > prior.receipt.updatedAt
          || (copy.receipt.updatedAt === prior.receipt.updatedAt && copy.receipt.jobId < prior.receipt.jobId)))) {
      receiptCopyByKey.set(key, copy);
    }
  }
  const receiptCopies = [...receiptCopyByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, copy]) => copy);
  const applicationPlan = planApplicationIdentityMigration(applications, sessions, canonicalByJobId);
  const facts = {
    updates: updates.map((job) => [job.jobId, job.postingIdentity?.aliases.map((alias: PostingAlias) => alias.value)]),
    duplicateIds: [...duplicateIds].sort(),
    receipts: receiptCopies.map(({ receipt, canonicalJobId, dedupeKey }) => [receipt.userId, receipt.jobId, receipt.token, canonicalJobId, dedupeKey]).sort(),
    applications: applicationPlan.writes.map(({ pk, sk, application, expectedUpdatedAt }) => [pk, sk, application, expectedUpdatedAt] as const)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    applicationDeletes: applicationPlan.deletes.map(({ pk, sk }) => [pk, sk]).sort(),
    applicationSessions: applicationPlan.sessionWrites.map(({ pk, sk, session }) => [pk, sk, session.applicationId, session.jobId]).sort(),
    conflicts: [...conflicts].sort(),
  };
  const repairToken = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return {
    openJobs: jobs.filter((job) => job.open).length,
    receiptRows: receipts.length,
    referencedJobs: selected.filter((job) => receiptJobIds.has(job.jobId)).length,
    identityClaims: aliases.length,
    jobUpdates: updates.length,
    duplicateOpenJobs: duplicateIds.length,
    occurrenceRemaps: 0,
    receiptCopies: receiptCopies.length,
    applicationRows: applications.length,
    applicationRemaps: applicationPlan.writes.length,
    applicationMerges: applicationPlan.deletes.length,
    applicationSessionRemaps: applicationPlan.sessionWrites.length,
    activeAlertPreferences: 0,
    conflicts,
    repairToken,
    applied: false,
    updates,
    aliases,
    duplicateIds,
    canonicalByJobId,
    receipts: receiptCopies,
    applications: applicationPlan,
  };
}

async function scanAll(client: DynamoDBDocumentClient, tableName: string) {
  const items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    items.push(...(page.Items ?? [])); cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}

export async function migratePostingIdentity(
  internshipsTable: string,
  usersTable: string,
  client: DynamoDBDocumentClient,
  options: { apply?: boolean; expectedRepairToken?: string } = {},
): Promise<PostingIdentityMigrationReport> {
  const [internshipItems, userItems] = await Promise.all([scanAll(client, internshipsTable), scanAll(client, usersTable)]);
  const jobs = internshipItems.map((item) => (item as JobItem).job).filter((job): job is Internship => Boolean(job));
  const receipts = userItems.filter((item) => (item as ReceiptItem).kind === 'receipt')
    .map((item) => (item as ReceiptItem).value).filter((receipt): receipt is DeliveryReceipt => Boolean(receipt));
  const applications = userItems.filter((item): item is UserValueItem<ApplicationRecord> =>
    (item as { kind?: string }).kind === 'application' && typeof item.pk === 'string' && typeof item.sk === 'string')
    .map((item) => ({ userId: userIdFromPk(item.pk), application: item.value, pk: item.pk, sk: item.sk }))
    .filter((item) => Boolean(item.userId && item.application));
  const applicationSessions = userItems.filter((item): item is UserValueItem<ApplicationSession> =>
    (item as { kind?: string }).kind === 'application-session' && typeof item.pk === 'string' && typeof item.sk === 'string')
    .map((item) => ({ userId: userIdFromPk(item.pk), session: item.value, pk: item.pk, sk: item.sk }))
    .filter((item) => Boolean(item.userId && item.session));
  const activePreferences = userItems.filter((item) => (item as { kind?: string }).kind === 'preferences')
    .map((item) => (item as { value?: UserPreferences }).value)
    .filter((value): value is UserPreferences => Boolean(value?.alertsEnabled && value.onboardingComplete));
  const plan = planPostingIdentityMigration(jobs, receipts, applications, applicationSessions);
  plan.activeAlertPreferences = activePreferences.length;
  plan.repairToken = createHash('sha256').update(`${plan.repairToken}\0${activePreferences.map((value) => value.userId).sort().join('\0')}`).digest('hex');
  plan.occurrenceRemaps = internshipItems.filter((item) => {
    const occurrence = (item as JobItem).occurrence;
    return Boolean(occurrence && plan.canonicalByJobId.get(occurrence.jobId) && plan.canonicalByJobId.get(occurrence.jobId) !== occurrence.jobId);
  }).length;
  if (!options.apply) return plan;
  if (!options.expectedRepairToken || options.expectedRepairToken !== plan.repairToken) {
    throw new Error(`Refusing apply: expected repair token ${plan.repairToken}`);
  }
  if (plan.conflicts.length) throw new Error(`Refusing apply with ${plan.conflicts.length} identity conflicts`);
  const internshipStore = new DynamoInternshipStore(internshipsTable, client);
  const userStore = new DynamoUserStore(usersTable, client);
  const scannedJobs = new Map(jobs.map((job) => [job.jobId, job]));
  for (const claim of plan.aliases) {
    const result = await internshipStore.claimPostingIdentity(claim.identity, claim.canonicalJobId);
    if (result.outcome === 'quarantine') throw new Error(`Alias claim conflict: ${result.reason}`);
  }
  for (const update of plan.updates) {
    const expected = scannedJobs.get(update.jobId);
    if (!expected || !await internshipStore.migrateInternship(update, expected)) {
      throw new Error(`Catalog changed while migrating ${update.jobId}; rerun the dry-run before apply`);
    }
  }
  for (const item of internshipItems) {
    const value = item as JobItem;
    const occurrence = value.occurrence;
    const canonicalJobId = occurrence && plan.canonicalByJobId.get(occurrence.jobId);
    if (!value.pk || !value.sk || !occurrence || !canonicalJobId || canonicalJobId === occurrence.jobId) continue;
    await client.send(new UpdateCommand({
      TableName: internshipsTable, Key: { pk: value.pk, sk: value.sk },
      UpdateExpression: 'SET occurrence.jobId = :jobId',
      ConditionExpression: 'occurrence.jobId = :oldJobId',
      ExpressionAttributeValues: { ':jobId': canonicalJobId, ':oldJobId': occurrence.jobId },
    }));
  }
  for (const copy of plan.receipts) {
    await userStore.migrateReceipt({ ...copy.receipt, jobId: copy.canonicalJobId }, copy.dedupeKey);
  }
  for (const write of plan.applications.writes) {
    await client.send(new UpdateCommand({
      TableName: usersTable, Key: { pk: write.pk, sk: write.sk },
      UpdateExpression: 'SET #value = :value',
      ConditionExpression: '#value.applicationId = :applicationId AND #value.updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#value': 'value' },
      ExpressionAttributeValues: {
        ':value': write.application, ':applicationId': write.application.applicationId, ':updatedAt': write.expectedUpdatedAt,
      },
    }));
  }
  for (const write of plan.applications.sessionWrites) {
    await client.send(new UpdateCommand({
      TableName: usersTable, Key: { pk: write.pk, sk: write.sk },
      UpdateExpression: 'SET #value = :value',
      ConditionExpression: '#value.sessionId = :sessionId AND #value.#version = :version',
      ExpressionAttributeNames: { '#value': 'value', '#version': 'version' },
      ExpressionAttributeValues: { ':value': write.session, ':sessionId': write.session.sessionId, ':version': write.session.version },
    }));
  }
  for (const application of plan.applications.deletes) {
    await client.send(new DeleteCommand({
      TableName: usersTable, Key: { pk: application.pk, sk: application.sk },
      ConditionExpression: '#value.applicationId = :applicationId AND #value.updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#value': 'value' },
      ExpressionAttributeValues: { ':applicationId': application.applicationId, ':updatedAt': application.expectedUpdatedAt },
    }));
  }
  for (const preference of activePreferences) await userStore.putPreferences(preference);
  for (const jobId of plan.duplicateIds) {
    const expected = scannedJobs.get(jobId);
    if (!expected) throw new Error(`Missing scanned duplicate job ${jobId}`);
    await client.send(new DeleteCommand({
      TableName: internshipsTable, Key: { pk: `JOB#${jobId}`, sk: 'META' },
      ConditionExpression: 'job = :expectedJob',
      ExpressionAttributeValues: { ':expectedJob': expected },
    }));
  }
  return { ...plan, applied: true };
}

async function main() {
  const internshipsTable = process.env.INTERNSHIPS_TABLE;
  const usersTable = process.env.USERS_TABLE;
  if (!internshipsTable || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  const apply = process.argv.includes('--apply');
  const tokenIndex = process.argv.indexOf('--expected-repair-token');
  const expectedRepairToken = tokenIndex >= 0 ? process.argv[tokenIndex + 1] : undefined;
  if (apply && !expectedRepairToken) throw new Error('--apply requires --expected-repair-token from a preceding dry-run');
  const report = await migratePostingIdentity(
    internshipsTable,
    usersTable,
    createDynamoDocumentClient(new DynamoDBClient({})),
    { apply, ...(expectedRepairToken ? { expectedRepairToken } : {}) },
  );
  const safe: PostingIdentityMigrationReport = {
    openJobs: report.openJobs,
    receiptRows: report.receiptRows,
    referencedJobs: report.referencedJobs,
    identityClaims: report.identityClaims,
    jobUpdates: report.jobUpdates,
    duplicateOpenJobs: report.duplicateOpenJobs,
    occurrenceRemaps: report.occurrenceRemaps,
    receiptCopies: report.receiptCopies,
    applicationRows: report.applicationRows,
    applicationRemaps: report.applicationRemaps,
    applicationMerges: report.applicationMerges,
    applicationSessionRemaps: report.applicationSessionRemaps,
    activeAlertPreferences: report.activeAlertPreferences,
    conflicts: report.conflicts,
    repairToken: report.repairToken,
    applied: report.applied,
  };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...safe }));
}

if (process.argv[1]?.endsWith('migrate-posting-identity.ts')) void main();
