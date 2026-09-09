import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseShadowPublicationPolicy, policyAllows, shadowExtractionEvidence } from '../src/shadow-publication.js';
import cloudflareWorker, { type Environment } from '../cloudflare/worker.js';
import { reconcileRoleMetadata, ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { ShadowExtraction } from '../src/shadow-extraction.js';
import type { RoleMetadataEvidence } from '../src/types.js';

const hash = 'a'.repeat(64);

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(query) {
      let values: SQLInputValue[] = [];
      const statement: D1PreparedStatement = {
        bind(...next) { values = next as SQLInputValue[]; return statement; },
        async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
        async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

function publicationDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0003_billing_shutdown.sql', '0020_shadow_extraction.sql', '0021_shadow_extraction_fencing.sql',
    '0022_shadow_extraction_cache_expiry.sql', '0023_shadow_extraction_attempt_costs.sql', '0024_shadow_publication_receipts.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  database.prepare(`INSERT INTO shadow_extraction_runs
    (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
      schema_version, preprocessing_version, state, input_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`).run(
    hash, 'job-1', 'greenhouse-acme', '123', 'https://jobs.example/123', '{}', hash, 'model', 'prompt', 'schema', 'preprocessing', 'input',
    '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z',
  );
  database.prepare(`INSERT INTO shadow_extraction_posting_revisions (job_id, source_id, external_id, content_hash, observed_at)
    VALUES (?, ?, ?, ?, ?)`).run('job-1', 'greenhouse-acme', '123', hash, '2026-09-08T00:00:00.000Z');
  for (const field of ['locations', 'workMode']) database.prepare(`INSERT INTO shadow_extraction_field_outcomes
    (run_key, field, status, accepted) VALUES (?, ?, 'present', 1)`).run(hash, field);
  return database;
}

async function createReceipt(database: DatabaseSync, version: string, acceptedFields: string[]) {
  const policy = { enabled: true, version, allowedFields: ['locations', 'workMode'],
    cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] };
  const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
    body: JSON.stringify({ action: 'create-receipt', runKey: hash, acceptedFields }),
  }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database),
    LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) } as unknown as Environment);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ receiptId: string; evidenceFingerprint: string }>;
}

describe('shadow publication policy', () => {
  it('fails closed for absent, malformed, duplicate, and unsupported policies', () => {
    expect(parseShadowPublicationPolicy(undefined).enabled).toBe(false);
    expect(parseShadowPublicationPolicy('{oops').enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['housing'], cohort: [] })).enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations', 'locations'], cohort: [] })).enabled).toBe(false);
  });

  it('requires all three exact cohort identity parts', () => {
    const policy = parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations'], cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] }));
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash })).toBe(true);
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '124', contentHash: hash })).toBe(false);
  });

  it('converts only supported, receipt-allowed fields with quoted provenance', () => {
    const extraction: ShadowExtraction = {
      classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
      fields: {
        compensation: { value: [{ min: 50, max: 60, currency: 'USD', period: 'hour' }], status: 'present', evidence: ['$50 - $60 per hour'], qualifiers: [] },
        locations: { value: ['Austin, TX'], status: 'present', evidence: ['Location: Austin, TX'], qualifiers: [] },
        workMode: { value: 'hybrid', status: 'present', evidence: ['Work mode: hybrid'], qualifiers: [] },
        housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      },
    };
    const evidence = shadowExtractionEvidence({ extraction, sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', contentHash: hash,
      observedAt: '2026-09-08T00:00:00.000Z', extractionVersion: 1, allowedFields: ['locations', 'workMode'] });
    expect(evidence?.compensationRanges).toBeUndefined();
    expect(evidence?.locations?.[0]).toMatchObject({ name: 'Austin, TX', workMode: 'unspecified' });
    expect(evidence?.workMode?.provenance[0]?.source).toBe('reviewed-shadow');
  });

  it('uses reviewed shadow fields only as fallback to direct official evidence', () => {
    const extraction: ShadowExtraction = {
      classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
      fields: {
        compensation: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        locations: { value: ['Austin, TX'], status: 'present', evidence: ['Location: Austin, TX'], qualifiers: [] },
        workMode: { value: 'hybrid', status: 'present', evidence: ['Work mode: hybrid'], qualifiers: [] },
        housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      },
    };
    const shadow = shadowExtractionEvidence({ extraction, sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', contentHash: hash,
      observedAt: '2026-09-08T00:00:00.000Z', extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, allowedFields: ['locations', 'workMode'] })!;
    const official: RoleMetadataEvidence = {
      schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash: 'official', sourceClass: 'official-page',
      sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', observedAt: '2026-09-08T00:00:00.000Z', exactPosting: true,
      workMode: { value: 'remote', provenance: [{ source: 'official-page', sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123',
        contentHash: 'official', observedAt: '2026-09-08T00:00:00.000Z', evidenceCode: 'page-work-mode' }] },
    };
    const metadata = reconcileRoleMetadata([shadow, official]).metadata;
    expect(metadata?.workMode?.value).toBe('remote');
    expect(metadata?.locations?.[0]?.name).toBe('Austin, TX');
  });

  it('keeps changed review decisions append-only and identical receipt creation idempotent', async () => {
    const database = publicationDatabase();
    const first = await createReceipt(database, 'v1', ['locations']);
    const second = await createReceipt(database, 'v2', ['workMode']);
    const repeated = await createReceipt(database, 'v2', ['workMode']);
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(repeated).toEqual(second);
    const rows = database.prepare(`SELECT receipt_id, policy_version, accepted_fields, evidence_fingerprint
      FROM shadow_publication_receipts ORDER BY policy_version`).all();
    expect(rows).toEqual([
      { receipt_id: first.receiptId, policy_version: 'v1', accepted_fields: '["locations"]', evidence_fingerprint: first.evidenceFingerprint },
      { receipt_id: second.receiptId, policy_version: 'v2', accepted_fields: '["workMode"]', evidence_fingerprint: second.evidenceFingerprint },
    ]);
  });
});
