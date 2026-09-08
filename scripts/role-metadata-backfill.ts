#!/usr/bin/env node

const endpoint = process.env.CATALOG_API_URL?.replace(/\/$/u, '');
const secret = process.env.OPERATIONS_SHARED_SECRET;
if (!endpoint || !secret) throw new Error('CATALOG_API_URL and OPERATIONS_SHARED_SECRET are required');

const args = process.argv.slice(2);
const command = args[0] ?? 'dry-run';
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const integer = (name: string, fallback?: number) => {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Operations-Key': secret, ...init?.headers },
  });
  const value = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

async function main() {
  if (command === 'audit') {
    console.log(JSON.stringify(await request('/internal/role-metadata/audit'), null, 2));
    return;
  }
  if (command === 'collect') {
    console.log(JSON.stringify(await request('/internal/role-metadata/backfill', {
      method: 'POST', body: JSON.stringify({ action: 'collect', limit: integer('--limit', 100), collectionToken: option('--collection-token'), cursor: option('--cursor') }),
    }), null, 2));
    return;
  }
  if (command === 'dry-run') {
    console.log(JSON.stringify(await request('/internal/role-metadata/backfill', { method: 'POST', body: JSON.stringify({ action: 'dry-run' }) }), null, 2));
    return;
  }
  if (command === 'preview-omission') {
    const jobId = option('--job-id');
    if (!jobId) throw new Error('preview-omission requires --job-id');
    console.log(JSON.stringify(await request('/internal/role-metadata/review', {
      method: 'POST', body: JSON.stringify({ action: command, jobId }),
    }), null, 2));
    return;
  }
  if (command === 'approve-omission') {
    const reviewToken = option('--review-token');
    const expectedDecisions = integer('--expected-decisions');
    if (!reviewToken || expectedDecisions !== 1) throw new Error('approve-omission requires the exact --review-token and --expected-decisions 1 from an approved preview');
    console.log(JSON.stringify(await request('/internal/role-metadata/review', {
      method: 'POST', body: JSON.stringify({ action: command, reviewToken, expectedDecisions }),
    }), null, 2));
    return;
  }
  if (command === 'apply') {
    const repairToken = option('--repair-token');
    const expectedJobs = integer('--expected-jobs');
    const expectedOccurrences = integer('--expected-occurrences');
    if (!repairToken || expectedJobs === undefined || expectedOccurrences === undefined) {
      throw new Error('apply requires --repair-token, --expected-jobs, and --expected-occurrences from one dry-run');
    }
    console.log(JSON.stringify(await request('/internal/role-metadata/backfill', {
      method: 'POST', body: JSON.stringify({ action: 'apply', repairToken, expectedJobs, expectedOccurrences }),
    }), null, 2));
    return;
  }
  throw new Error('Usage: role-metadata-backfill.ts audit | collect [--limit N] | dry-run | preview-omission --job-id ID | approve-omission --review-token TOKEN --expected-decisions 1 | apply --repair-token TOKEN --expected-jobs N --expected-occurrences N');
}

void main();
