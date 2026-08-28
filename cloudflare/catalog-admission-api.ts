import type { CanonicalEmployer, DestinationReviewRule, EmployerMapping } from '../src/types.js';
import { ATOMIC_REPAIR_RECORD_LIMIT } from './catalog-admission-store.js';
import type { D1CatalogAdmissionStore, RepairChange } from './catalog-admission-store.js';

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, maximum = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${name} is required`);
  return value.trim();
}

function reviewReason(input: Record<string, unknown>, fallback: string): string {
  return typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : fallback;
}

export async function handleCatalogAdmissionOperations(
  request: Request,
  store: D1CatalogAdmissionStore,
  refreshProjection: () => Promise<unknown>,
  actor = 'operations-reviewer',
  now = () => new Date(),
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const timestamp = now().toISOString();
  try {
    if (request.method === 'GET' && path === '/internal/admission/audit') return json(200, await store.audit());
    if (request.method === 'GET' && path === '/internal/admission/employers') return json(200, { employers: await store.listCanonicalEmployers() });
    if (request.method === 'PUT' && path === '/internal/admission/employers') {
      const input = await body(request);
      const employer: CanonicalEmployer = {
        id: text(input.id, 'id', 160), displayName: text(input.displayName, 'displayName', 160),
        reviewedAt: timestamp, reviewedBy: actor,
        ...(typeof input.parentEmployerId === 'string' && input.parentEmployerId.trim() ? { parentEmployerId: input.parentEmployerId.trim() } : {}),
        ...(typeof input.brandOfEmployerId === 'string' && input.brandOfEmployerId.trim() ? { brandOfEmployerId: input.brandOfEmployerId.trim() } : {}),
      };
      await store.putCanonicalEmployer(employer, timestamp);
      await store.recordReviewerDecision({ id: crypto.randomUUID(), subjectType: 'canonical-employer', subjectId: employer.id,
        decision: 'approved', reason: reviewReason(input, 'Canonical employer reviewed'), reviewedAt: timestamp, reviewedBy: actor });
      return json(200, { employer });
    }
    if (request.method === 'GET' && path === '/internal/admission/mappings') return json(200, { mappings: await store.listEmployerMappings() });
    if (request.method === 'POST' && path === '/internal/admission/mappings') {
      const input = await body(request);
      const provider = text(input.provider, 'provider', 80) as EmployerMapping['provider'];
      const allowed: EmployerMapping['provider'][] = ['greenhouse', 'lever', 'ashby', 'workday', 'bytedance', 'unknown', 'github', 'structured', 'employer-submission'];
      if (!allowed.includes(provider)) throw new Error('provider is invalid');
      const mapping: EmployerMapping = {
        id: text(input.id ?? crypto.randomUUID(), 'id', 160), provider, scope: text(input.scope, 'scope', 300),
        canonicalEmployerId: text(input.canonicalEmployerId, 'canonicalEmployerId', 160), reviewedAt: timestamp, reviewedBy: actor,
        ...(typeof input.supersedesMappingId === 'string' && input.supersedesMappingId.trim() ? { supersedesMappingId: input.supersedesMappingId.trim() } : {}),
      };
      await store.supersedeEmployerMapping(mapping);
      await store.recordReviewerDecision({ id: crypto.randomUUID(), subjectType: 'employer-mapping', subjectId: mapping.id,
        decision: mapping.supersedesMappingId ? 'superseded' : 'approved', reason: reviewReason(input, 'Employer mapping reviewed'),
        reviewedAt: timestamp, reviewedBy: actor });
      return json(201, { mapping });
    }
    if (request.method === 'GET' && path === '/internal/admission/host-rules') return json(200, { rules: await store.listReviewRules() });
    if (request.method === 'PUT' && path === '/internal/admission/host-rules') {
      const input = await body(request);
      const decision = text(input.decision, 'decision', 80) as DestinationReviewRule['decision'];
      if (!['standard-provider-route', 'browser-required', 'aggregate-board', 'blocked-accepted'].includes(decision)) throw new Error('decision is invalid');
      const rule: DestinationReviewRule = {
        id: text(input.id ?? crypto.randomUUID(), 'id', 160), host: text(input.host, 'host', 253).toLowerCase(),
        provider: text(input.provider, 'provider', 80) as DestinationReviewRule['provider'], decision,
        reviewedAt: timestamp, reviewedBy: actor,
        ...(typeof input.tenant === 'string' && input.tenant.trim() ? { tenant: input.tenant.trim() } : {}),
        ...(typeof input.sampleDueAt === 'string' && !Number.isNaN(Date.parse(input.sampleDueAt)) ? { sampleDueAt: new Date(input.sampleDueAt).toISOString() } : {}),
      };
      await store.putReviewRule(rule);
      await store.recordReviewerDecision({ id: crypto.randomUUID(), subjectType: 'destination-rule', subjectId: rule.id,
        decision: rule.decision, reason: reviewReason(input, 'Destination host rule reviewed'), reviewedAt: timestamp, reviewedBy: actor });
      return json(200, { rule });
    }
    if (request.method === 'GET' && path === '/internal/admission/incidents') return json(200, { incidents: await store.listActiveIncidents() });
    if (request.method === 'POST' && path === '/internal/admission/repair') {
      const input = await body(request);
      if (input.apply === true) {
        const repairToken = text(input.repairToken, 'repairToken', 128);
        const expectedChanged = input.expectedChanged;
        if (typeof expectedChanged !== 'number' || !Number.isInteger(expectedChanged) || expectedChanged < 0
          || expectedChanged > ATOMIC_REPAIR_RECORD_LIMIT) throw new Error('expectedChanged is invalid');
        const expectedOccurrencesChanged = input.expectedOccurrencesChanged;
        if (typeof expectedOccurrencesChanged !== 'number' || !Number.isInteger(expectedOccurrencesChanged)
          || expectedOccurrencesChanged < 0 || expectedOccurrencesChanged > ATOMIC_REPAIR_RECORD_LIMIT
          || expectedChanged + expectedOccurrencesChanged > ATOMIC_REPAIR_RECORD_LIMIT) throw new Error('expectedOccurrencesChanged is invalid');
        const result = await store.applyRepair(repairToken, expectedChanged, timestamp, expectedOccurrencesChanged);
        await store.recordReviewerDecision({ id: crypto.randomUUID(), subjectType: 'catalog-repair', subjectId: repairToken,
          decision: 'applied', reason: reviewReason(input, 'Guarded catalog admission repair approved'), reviewedAt: timestamp, reviewedBy: actor });
        if (result.projectionRefreshRequired) await refreshProjection();
        return json(200, { ...result, applied: true });
      }
      if (!Array.isArray(input.changes) || input.changes.length > ATOMIC_REPAIR_RECORD_LIMIT) {
        throw new Error(`changes must be an array with at most ${ATOMIC_REPAIR_RECORD_LIMIT} rows`);
      }
      const changes = input.changes as RepairChange[];
      if (changes.some((change) => !change || typeof change !== 'object' || typeof change.jobId !== 'string' || !change.admission || typeof change.admission !== 'object')) throw new Error('Every repair change needs a jobId and admission');
      return json(200, { ...(await store.stageRepair(changes, timestamp)), applied: false });
    }
    return json(404, { message: 'Not found' });
  } catch (error) {
    return json(409, { message: error instanceof Error ? error.message : 'Admission operation failed' });
  }
}
