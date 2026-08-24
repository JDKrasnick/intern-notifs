import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { buildPostingIdentity } from './identity/posting.js';
import { notificationDedupeKey } from './notifications.js';
import { createDynamoDocumentClient, DynamoInternshipStore, DynamoUserStore } from './store.js';
import type { DeliveryReceipt, Internship, PostingAlias, PostingIdentity, SourceOccurrence, UserPreferences } from './types.js';

type JobItem = { pk?: string; sk?: string; job?: Internship; occurrence?: { jobId: string } };
type ReceiptItem = { kind?: string; value?: DeliveryReceipt };

export interface PostingIdentityMigrationReport {
  openJobs: number;
  receiptRows: number;
  referencedJobs: number;
  identityClaims: number;
  jobUpdates: number;
  duplicateOpenJobs: number;
  occurrenceRemaps: number;
  receiptCopies: number;
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
};

function first(value: Internship) { return value.firstSeenAt || value.lastSeenAt; }
function earliest(values: string[]) { return [...values].sort()[0]!; }
function latest(values: string[]) { return [...values].sort().at(-1)!; }

function referenceKey(reference: SourceOccurrence) {
  return `${reference.sourceId}\0${reference.externalId ?? ''}\0${reference.document ?? ''}\0${reference.row ?? ''}`;
}

function mergedJob(canonical: Internship, jobs: Internship[], identity: PostingIdentity): Internship {
  const references = [...new Map(jobs.flatMap((job) => job.sourceReferences).map((reference) => [referenceKey(reference), reference])).values()];
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

export function planPostingIdentityMigration(jobs: Internship[], receipts: DeliveryReceipt[]): MigrationPlan {
  const receiptJobIds = new Set(receipts.map((receipt) => receipt.jobId));
  const selected = jobs.filter((job) => job.open || receiptJobIds.has(job.jobId));
  const conflicts: string[] = [];
  const identities = new Map<string, PostingIdentity>();
  for (const job of selected) {
    try { identities.set(job.jobId, buildPostingIdentity({ applicationUrl: job.applyUrl })); }
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

  const receiptCopies = receipts.flatMap((receipt) => {
    const canonicalJobId = canonicalByJobId.get(receipt.jobId);
    const canonical = canonicalJobId && canonicalJobs.get(canonicalJobId);
    if (!canonicalJobId || !canonical) return [];
    return [{ receipt, canonicalJobId, dedupeKey: notificationDedupeKey(canonical) }];
  });
  const facts = {
    updates: updates.map((job) => [job.jobId, job.postingIdentity?.aliases.map((alias: PostingAlias) => alias.value)]),
    duplicateIds: [...duplicateIds].sort(),
    receipts: receiptCopies.map(({ receipt, canonicalJobId, dedupeKey }) => [receipt.userId, receipt.jobId, receipt.token, canonicalJobId, dedupeKey]).sort(),
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
    activeAlertPreferences: 0,
    conflicts,
    repairToken,
    applied: false,
    updates,
    aliases,
    duplicateIds,
    canonicalByJobId,
    receipts: receiptCopies,
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
  const activePreferences = userItems.filter((item) => (item as { kind?: string }).kind === 'preferences')
    .map((item) => (item as { value?: UserPreferences }).value)
    .filter((value): value is UserPreferences => Boolean(value?.alertsEnabled && value.onboardingComplete));
  const plan = planPostingIdentityMigration(jobs, receipts);
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
  for (const claim of plan.aliases) {
    const result = await internshipStore.claimPostingIdentity(claim.identity, claim.canonicalJobId);
    if (result.outcome === 'quarantine') throw new Error(`Alias claim conflict: ${result.reason}`);
  }
  for (const update of plan.updates) await internshipStore.putInternship(update);
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
  for (const preference of activePreferences) await userStore.putPreferences(preference);
  for (const jobId of plan.duplicateIds) {
    await client.send(new DeleteCommand({ TableName: internshipsTable, Key: { pk: `JOB#${jobId}`, sk: 'META' } }));
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
    activeAlertPreferences: report.activeAlertPreferences,
    conflicts: report.conflicts,
    repairToken: report.repairToken,
    applied: report.applied,
  };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...safe }));
}

if (process.argv[1]?.endsWith('migrate-posting-identity.ts')) void main();
