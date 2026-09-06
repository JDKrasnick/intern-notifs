import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "..");
const outputDirectory = resolve(mobileRoot, "dist");
const publicApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim()
  || "https://intern-notifs.jdkrasnick.workers.dev";
const policyFiles = [
  "policy.css",
  "privacy.html",
  "retention.html",
  "source-policy.html",
  "support.html",
  "terms.html",
];

await rm(outputDirectory, { recursive: true, force: true });
execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["expo", "export", "--clear", "--platform", "web", "--output-dir", outputDirectory],
  {
    cwd: mobileRoot,
    env: { ...process.env, EXPO_PUBLIC_API_URL: publicApiUrl, INTERNNOTIFS_PAGES_EXPORT: '1' },
    stdio: "inherit",
  },
);

await mkdir(outputDirectory, { recursive: true });
await Promise.all(policyFiles.map((name) => copyFile(resolve(repositoryRoot, "docs", name), resolve(outputDirectory, name))));

const requiredFiles = ["index.html", "_headers", ...policyFiles];
await Promise.all(requiredFiles.map(async (name) => {
  const value = await readFile(resolve(outputDirectory, name));
  if (value.byteLength === 0) throw new Error(`Web export produced an empty ${name}`);
}));

const bundleDirectory = resolve(outputDirectory, "_expo", "static", "js", "web");
const bundles = (await readdir(bundleDirectory)).filter((name) => name.endsWith(".js"));
const bundleText = (await Promise.all(bundles.map((name) => readFile(resolve(bundleDirectory, name), "utf8")))).join("\n");
if (!bundleText.includes(publicApiUrl)) {
  throw new Error(`Web export did not embed the expected API origin ${publicApiUrl}`);
}
const assetPaths = [...bundleText.matchAll(/"(\/assets\/[^"?]+)"/gu)].map((match) => match[1]);
if (!assetPaths.length) throw new Error('Web export did not expose any verifiable runtime assets');
await Promise.all([...new Set(assetPaths)].map(async (assetPath) => {
  if (assetPath.split('/').includes('node_modules')) throw new Error(`Pages would exclude ${assetPath}`);
  const exportedAsset = await readFile(resolve(outputDirectory, `.${assetPath}`));
  if (!exportedAsset.byteLength) throw new Error(`Web export produced an empty runtime asset ${assetPath}`);
}));

console.log(`Verified deployable web export at ${outputDirectory} using API ${publicApiUrl}`);
