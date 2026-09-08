import { describe, expect, it } from 'vitest';
import apiWorker, { type ApiEnvironment } from '../cloudflare/api-worker.js';
import ingestionWorker, { type IngestionEnvironment } from '../cloudflare/ingestion-worker.js';
import { isIngestionOperationPath, secretMatches } from '../cloudflare/split.js';

describe('API and ingestion Worker boundary', () => {
  it('forwards only ingestion operations through the authenticated service binding', async () => {
    let forwarded: Request | undefined;
    const env = {
      INTERNAL_SERVICE_SECRET: 'internal-test-secret',
      OPERATIONS_SHARED_SECRET: 'operations-test-secret',
      DEPLOYMENT_ROLE: 'api', VERSION_METADATA: { id: 'api-version' },
      INGESTION: { async fetch(request: Request) { forwarded = request; return Response.json({ queued: 0 }); } },
    } as ApiEnvironment;

    const response = await apiWorker.fetch(new Request('https://api.example.test/internal/backfill', { method: 'POST' }), env);

    expect(response.status).toBe(200);
    expect(forwarded?.headers.get('X-InternNotifs-Service-Key')).toBe('internal-test-secret');
    expect(isIngestionOperationPath('/internal/backfill')).toBe(true);
    expect(isIngestionOperationPath('/jobs')).toBe(false);
  });

  it('reports both Worker identities only to an authorized operator', async () => {
    const env = {
      INTERNAL_SERVICE_SECRET: 'internal-test-secret', OPERATIONS_SHARED_SECRET: 'operations-test-secret',
      DEPLOYMENT_ROLE: 'api', VERSION_METADATA: { id: 'api-version' },
      INGESTION: { async fetch() { return Response.json({ role: 'ingestion', version: { id: 'ingestion-version' } }); } },
    } as ApiEnvironment;

    const denied = await apiWorker.fetch(new Request('https://api.example.test/internal/deployment'), env);
    expect(denied.status).toBe(404);
    const allowed = await apiWorker.fetch(new Request('https://api.example.test/internal/deployment', {
      headers: { 'X-Operations-Key': 'operations-test-secret' },
    }), env);
    expect(await allowed.json()).toEqual({
      api: { role: 'api', version: { id: 'api-version' } },
      ingestion: { role: 'ingestion', version: { id: 'ingestion-version' } },
    });
  });

  it('does not expose the ingestion Worker without service authentication', async () => {
    const env = { INTERNAL_SERVICE_SECRET: 'internal-test-secret' } as IngestionEnvironment;
    const response = await ingestionWorker.fetch(new Request('https://ingestion.example.test/internal/backfill', { method: 'POST' }), env);
    expect(response.status).toBe(404);
  });

  it('requires a matching service secret even when the request has an operations key', async () => {
    const env = { INTERNAL_SERVICE_SECRET: 'internal-test-secret', OPERATIONS_SHARED_SECRET: 'operations-test-secret' } as IngestionEnvironment;
    const response = await ingestionWorker.fetch(new Request('https://ingestion.example.test/internal/backfill', {
      method: 'POST', headers: { 'X-Operations-Key': 'operations-test-secret', 'X-InternNotifs-Service-Key': 'wrong-secret' },
    }), env);
    expect(response.status).toBe(404);
  });

  it('compares internal secrets without accepting an empty value', () => {
    expect(secretMatches('same', 'same')).toBe(true);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches('different', 'same')).toBe(false);
  });
});
