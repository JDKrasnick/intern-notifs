import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultSources } from '../src/sources/index.js';
import { qualityPolicyFor, verifySourceQuality } from '../src/sources/quality.js';

function outputPath() {
  const at = process.argv.indexOf('--output');
  return at >= 0 ? process.argv[at + 1] ?? 'artifacts/source-quality.json' : 'artifacts/source-quality.json';
}

async function withRetries<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      failure = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw failure;
}

async function main() {
  const inputs = await Promise.all(defaultSources.map(async (source) => {
    try {
      const result = await withRetries(() => source.fetch());
      return { policy: qualityPolicyFor(source.id), result };
    } catch (error) {
      return {
        policy: qualityPolicyFor(source.id),
        result: { sourceId: source.id, listings: [], notModified: false },
        fetchFailure: error instanceof Error ? error.message : String(error)
      };
    }
  }));
  const report = verifySourceQuality(inputs);
  for (const input of inputs) if ('fetchFailure' in input) report.failures.push(`${input.policy.id}: live fetch failed after retries: ${input.fetchFailure}`);
  const destination = outputPath();
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

void main();
