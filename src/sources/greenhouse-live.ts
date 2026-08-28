import { ApplicationUrlValidationError, validateApplicationUrl } from '../core/application-url.js';
import { admitGreenhouseSource, type ReviewedGreenhouseSource } from './greenhouse-config.js';
import { greenhouseJobsUrl, isGreenhouseJobShape, mapGreenhouseJob, type GreenhouseJobsResponse } from './greenhouse.js';
import { greenhouseApplicationUrlRejection } from './quality.js';
import type { RawListing } from '../types.js';

/** Fraction of eligible roles that may fail link health before the board quarantines. */
const LINK_FAILURE_THRESHOLD = 0.2;
const LINK_CHECK_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;

export type LiveCheckState = 'ok' | 'failed' | 'skipped' | 'inconclusive';

export interface GreenhouseLiveRoleFailure {
  document: string;
  reason: string;
}

export interface GreenhouseLiveContractResult {
  sourceId: string;
  /** `inconclusive` is an infrastructure outage: neither admit nor reject the board. */
  status: 'ok' | 'failed' | 'inconclusive';
  checks: {
    identity: LiveCheckState;
    schema: LiveCheckState;
    etagNotModified: LiveCheckState;
    linkHealth: LiveCheckState;
  };
  counts: { raw: number; eligible: number; withheld: number };
  roleFailures: GreenhouseLiveRoleFailure[];
  /** Safe, structured diagnostics only — never a description, credential, or full query string. */
  diagnostics: string[];
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    let next = queue.shift();
    while (next !== undefined) {
      await worker(next);
      next = queue.shift();
    }
  });
  await Promise.all(runners);
}

/**
 * Read-only live contract for one reviewed board: identity + exact board-name
 * match, response schema, an ETag conditional request, and per-role link health.
 * It makes only GET requests, never a POST, treats a transport outage as
 * `inconclusive`, and reports raw/eligible/withheld counts for owner review.
 */
export async function runGreenhouseLiveContract(
  source: ReviewedGreenhouseSource,
  fetchImpl: typeof fetch = fetch,
): Promise<GreenhouseLiveContractResult> {
  const diagnostics: string[] = [];
  const roleFailures: GreenhouseLiveRoleFailure[] = [];
  const counts = { raw: 0, eligible: 0, withheld: 0 };
  const checks: GreenhouseLiveContractResult['checks'] = {
    identity: 'skipped',
    schema: 'skipped',
    etagNotModified: 'skipped',
    linkHealth: 'skipped',
  };

  const inconclusive = (reason: string): GreenhouseLiveContractResult => {
    diagnostics.push(reason);
    return { sourceId: source.id, status: 'inconclusive', checks, counts, roleFailures, diagnostics };
  };
  const failed = (reason: string): GreenhouseLiveContractResult => {
    diagnostics.push(reason);
    return { sourceId: source.id, status: 'failed', checks, counts, roleFailures, diagnostics };
  };

  // 1. Identity and exact reviewed board-name match.
  try {
    const admission = await admitGreenhouseSource(source, fetchImpl);
    if (admission.ok) {
      checks.identity = 'ok';
    } else {
      checks.identity = 'failed';
      if (admission.inconclusive) return inconclusive(`identity ${admission.reason ?? 'unknown'}`);
      return failed(`identity ${admission.reason ?? 'unknown'}`);
    }
  } catch {
    return inconclusive('identity request could not be completed');
  }

  // 2. Jobs endpoint fetch and defensive schema validation.
  const jobsUrl = greenhouseJobsUrl(source.boardToken);
  let firstResponse: Response;
  try {
    firstResponse = await fetchImpl(jobsUrl, { headers: { Accept: 'application/json' }, signal: timeoutSignal() });
  } catch {
    return inconclusive('jobs request could not be completed');
  }
  if (!firstResponse.ok) {
    checks.schema = 'failed';
    return failed(`jobs endpoint returned HTTP ${firstResponse.status}`);
  }
  let payload: unknown;
  try {
    payload = await firstResponse.json();
  } catch {
    checks.schema = 'failed';
    return failed('jobs endpoint returned malformed JSON');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as GreenhouseJobsResponse).jobs)) {
    checks.schema = 'failed';
    return failed('jobs response shape was invalid');
  }
  const jobs = (payload as GreenhouseJobsResponse).jobs ?? [];
  counts.raw = jobs.length;
  for (const job of jobs) {
    if (!isGreenhouseJobShape(job)) {
      checks.schema = 'failed';
      return failed('a job row had an invalid shape');
    }
  }
  checks.schema = 'ok';

  // Map eligibility so every returned job parses without an adapter error and
  // off-allowlist destinations are recorded as withheld roles.
  const fetchedAt = new Date().toISOString();
  const eligible: RawListing[] = [];
  let row = 0;
  for (const job of jobs) {
    const mapped = mapGreenhouseJob(job, source, fetchedAt, row + 1);
    if (!mapped) continue;
    row += 1;
    const rejection = greenhouseApplicationUrlRejection(mapped.applyUrl, source.allowedInitialHosts);
    if (rejection) {
      counts.withheld += 1;
      roleFailures.push({ document: mapped.document, reason: rejection });
    } else {
      eligible.push({ ...mapped, row });
    }
  }
  counts.eligible = eligible.length;

  // 3. ETag conditional request: a returned ETag must yield HTTP 304.
  const etag = firstResponse.headers.get('etag');
  if (!etag) {
    checks.etagNotModified = 'skipped';
    diagnostics.push('board did not return an ETag');
  } else {
    try {
      const conditional = await fetchImpl(jobsUrl, {
        headers: { Accept: 'application/json', 'If-None-Match': etag },
        signal: timeoutSignal(),
      });
      if (conditional.status === 304) {
        checks.etagNotModified = 'ok';
      } else {
        checks.etagNotModified = 'failed';
        diagnostics.push(`ETag conditional returned HTTP ${conditional.status}, expected 304`);
      }
    } catch {
      checks.etagNotModified = 'inconclusive';
      diagnostics.push('ETag conditional request could not be completed');
    }
  }

  // 4. Per-role link health with bounded concurrency and the HEAD/GET fallback.
  const policy = { allowedInitialHosts: source.allowedInitialHosts, allowedFinalHosts: source.allowedFinalHosts };
  let linkFailures = 0;
  let linkOutages = 0;
  await mapWithConcurrency(eligible, LINK_CHECK_CONCURRENCY, async (listing) => {
    try {
      await validateApplicationUrl(listing.applyUrl, fetchImpl, policy);
    } catch (error) {
      if (error instanceof ApplicationUrlValidationError
        && /could not be reached|timed out|exceeds the inspection size limit/.test(error.message)) {
        linkOutages += 1;
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      linkFailures += 1;
      roleFailures.push({ document: listing.document, reason });
    }
  });

  if (eligible.length > 0 && linkOutages / eligible.length > LINK_FAILURE_THRESHOLD) {
    return inconclusive(`${linkOutages}/${eligible.length} link checks could not be completed`);
  }
  const linkFailureRate = eligible.length > 0 ? linkFailures / eligible.length : 0;
  checks.linkHealth = linkFailureRate > LINK_FAILURE_THRESHOLD ? 'failed' : 'ok';
  if (checks.linkHealth === 'failed') diagnostics.push(`${linkFailures}/${eligible.length} eligible roles failed link health`);

  const status = checks.identity !== 'ok'
    || checks.schema !== 'ok'
    || checks.etagNotModified === 'failed'
    || checks.linkHealth === 'failed'
    ? 'failed'
    : checks.etagNotModified === 'inconclusive'
      ? 'inconclusive'
    : 'ok';
  return { sourceId: source.id, status, checks, counts, roleFailures, diagnostics };
}
