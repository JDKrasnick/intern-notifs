import { build } from 'esbuild';

/* global console, process */

const result = await build({
  entryPoints: ['cloudflare/worker.ts'],
  bundle: true,
  write: false,
  metafile: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});

const awsInputs = Object.keys(result.metafile.inputs)
  .filter((path) => path.includes('node_modules/@aws-sdk/') || /(^|\/)src\/aws-[^/]+$/u.test(path))
  .sort();

if (awsInputs.length) {
  console.error(`Cloudflare Worker imports AWS-only modules:\n${awsInputs.join('\n')}`);
  process.exit(1);
}

const bytes = result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
console.log(`Cloudflare boundary is AWS-free (${bytes} uncompressed bytes).`);
