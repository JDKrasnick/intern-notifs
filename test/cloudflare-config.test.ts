import { existsSync, readFileSync } from 'node:fs';
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
    const wranglerCrons = quotedValuesBetween(read('wrangler.ingestion.jsonc'), '"crons": [', ']');
    const terraform = read('infra/cloudflare/main.tf');
    const cronResource = terraform.slice(terraform.indexOf('resource "cloudflare_workers_cron_trigger" "ingestion"'));
    const terraformCrons = quotedValuesBetween(cronResource, 'schedules = [', ']');

    expect(new Set(terraformCrons)).toEqual(new Set(wranglerCrons));
    expect(terraformCrons).toHaveLength(wranglerCrons.length);
  });

  it('assigns every cron and queue consumer to ingestion only', () => {
    const api = JSON.parse(read('wrangler.api.jsonc')) as { queues?: { producers?: Array<{ binding: string }>; consumers?: unknown[] }; triggers?: unknown };
    const ingestion = JSON.parse(read('wrangler.ingestion.jsonc')) as { queues: { producers: Array<{ binding: string }>; consumers: Array<{
      queue: string; max_batch_size: number; max_batch_timeout?: number; max_concurrency?: number; max_retries: number; dead_letter_queue: string;
    }> }; triggers: { crons: string[] }; workers_dev: boolean; preview_urls: boolean };

    expect(api.queues?.consumers ?? []).toEqual([]);
    expect(api.triggers).toBeUndefined();
    expect(api.queues?.producers?.map(({ binding }) => binding)).toEqual(['GMAIL_QUEUE']);
    expect(ingestion.queues.consumers.map(({ queue }) => queue)).toEqual([
      'intern-notifs-greenhouse', 'intern-notifs-lever', 'intern-notifs-ashby', 'intern-notifs-github', 'intern-notifs-gmail', 'intern-notifs-destination-verification',
    ]);
    expect(ingestion.triggers.crons).toHaveLength(9);
    expect(ingestion.workers_dev).toBe(false);
    expect(ingestion.preview_urls).toBe(false);
  });

  it('keeps destination-verification consumer limits synchronized across Wrangler and OpenTofu', () => {
    const ingestion = JSON.parse(read('wrangler.ingestion.jsonc')) as { queues: { consumers: Array<{
      queue: string; max_batch_size: number; max_batch_timeout?: number; max_concurrency?: number; max_retries: number; dead_letter_queue: string;
    }> } };
    const consumer = ingestion.queues.consumers.find(({ queue }) => queue === 'intern-notifs-destination-verification');
    expect(consumer).toEqual({
      queue: 'intern-notifs-destination-verification',
      max_batch_size: 5,
      max_batch_timeout: 60,
      max_concurrency: 1,
      max_retries: 2,
      dead_letter_queue: 'intern-notifs-destination-verification-dlq',
    });

    const terraform = read('infra/cloudflare/main.tf');
    const start = terraform.indexOf('resource "cloudflare_queue_consumer" "ingestion"');
    const end = terraform.indexOf('resource "cloudflare_workers_cron_trigger" "ingestion"', start);
    const queueConsumer = terraform.slice(start, end);
    expect(queueConsumer).toContain('batch_size       = each.key == "destination-verification" ? 5 : 1');
    expect(queueConsumer).toContain('max_concurrency  = contains(["greenhouse", "github"], each.key) ? 2 : 1');
    expect(queueConsumer).toContain('max_wait_time_ms = each.key == "destination-verification" ? 60000 : 5000');
  });

  it('requires explicit Worker configuration rather than retaining a shared default', () => {
    expect(existsSync(new URL('../wrangler.jsonc', import.meta.url))).toBe(false);
    const api = JSON.parse(read('wrangler.api.jsonc')) as { services: Array<{ binding: string; service: string }> };
    expect(api.services).toEqual([{ binding: 'INGESTION', service: 'intern-notifs-ingestion' }]);
  });
});
