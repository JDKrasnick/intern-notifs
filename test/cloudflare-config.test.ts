import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function quotedValuesBetween(source: string, start: string, end: string): string[] {
  const startAt = source.indexOf(start);
  if (startAt < 0) throw new Error(`Missing configuration marker: ${start}`);
  const valuesStart = startAt + start.length;
  const endAt = source.indexOf(end, valuesStart);
  if (endAt < 0) throw new Error(`Missing configuration marker: ${end}`);
  return [...source.slice(valuesStart, endAt).matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

describe('Cloudflare deployment configuration', () => {
  it('keeps Wrangler and OpenTofu cron schedules synchronized', () => {
    const wranglerCrons = quotedValuesBetween(read('wrangler.jsonc'), '"crons": [', ']');
    const terraform = read('infra/cloudflare/main.tf');
    const cronResource = terraform.slice(terraform.indexOf('resource "cloudflare_workers_cron_trigger" "application"'));
    const terraformCrons = quotedValuesBetween(cronResource, 'schedules = [', ']');

    expect(new Set(terraformCrons)).toEqual(new Set(wranglerCrons));
    expect(terraformCrons).toHaveLength(wranglerCrons.length);
  });
});
