import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiWorkerName = 'intern-notifs-e2e-api';
const ingestionWorkerName = 'intern-notifs-e2e-ingestion';
const internalServiceSecret = 'e2e-internal-service-secret';
const operationsSecret = 'e2e-operations-secret';
// Keep this at the newest date supported by the workerd version in package-lock.json.
const localCompatibilityDate = '2026-08-27';

let runtime;
let api;
let ingestion;

async function createWorkerConfig(name, bundleDirectory, bundleName, env) {
  return {
    config: {
      name,
      type: 'worker',
      compatibilityDate: localCompatibilityDate,
      compatibilityFlags: ['nodejs_compat'],
      manifest: {
        mainModule: bundleName,
        modulesRoot: bundleDirectory,
        modules: {
          [bundleName]: {
            type: 'esm',
            contents: await readFile(join(bundleDirectory, bundleName), 'utf8'),
          },
        },
      },
      env,
    },
  };
}

async function applyMigrations(database) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await database.batch(splitSqlQuery(sql).map((statement) => database.prepare(statement)));
  }
}

before(async () => {
  const apiBundleDirectory = join(repositoryRoot, 'cloudflare/dist/api');
  const ingestionBundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');

  runtime = new Miniflare({
    workers: [
      await createWorkerConfig(apiWorkerName, apiBundleDirectory, 'api-worker.js', {
        INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
        OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
        DEPLOYMENT_ROLE: { type: 'text', value: 'api' },
        IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: { type: 'text', value: 'false' },
        PUBLIC_API_URL: { type: 'text', value: 'https://api.example.test' },
        DB: { type: 'd1', id: 'intern-notifs-e2e' },
        INGESTION: { type: 'worker', workerName: ingestionWorkerName },
      }),
      await createWorkerConfig(
        ingestionWorkerName,
        ingestionBundleDirectory,
        'ingestion-worker.js',
        {
          INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
          OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
          DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
          DB: { type: 'd1', id: 'intern-notifs-e2e' },
        },
      ),
    ],
  });

  await runtime.ready;
  await applyMigrations(await runtime.getD1Database('DB', apiWorkerName));
  api = await runtime.getWorker(apiWorkerName);
  ingestion = await runtime.getWorker(ingestionWorkerName);
});

after(async () => {
  await runtime?.dispose();
});

test('reports both deployed roles through the real service binding', async () => {
  const denied = await api.fetch('https://api.example.test/internal/deployment');
  assert.equal(denied.status, 404);

  const response = await api.fetch('https://api.example.test/internal/deployment', {
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    api: { role: 'api', version: null },
    ingestion: { role: 'ingestion', version: null },
  });
});

test('preserves operation authentication across the Worker boundary', async () => {
  const denied = await api.fetch('https://api.example.test/internal/backfill?provider=invalid', {
    method: 'POST',
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { message: 'Not found' });

  const response = await api.fetch('https://api.example.test/internal/backfill?provider=invalid', {
    method: 'POST',
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { message: 'provider is invalid' });
});

test('keeps the ingestion Worker private without service authentication', async () => {
  const response = await ingestion.fetch('https://ingestion.example.test/internal/backfill?provider=invalid', {
    method: 'POST',
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { message: 'Not found' });
});

test('keeps public catalog requests on the API Worker', async () => {
  const response = await api.fetch('https://api.example.test/jobs');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).jobs, []);
});
