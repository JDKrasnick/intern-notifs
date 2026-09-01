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
  const wrangler = JSON.parse(read('wrangler.jsonc')) as {
    browser: { binding: string };
    queues: {
      producers: Array<{ binding: string; queue: string }>;
      consumers: Array<{
        queue: string;
        max_batch_size: number;
        max_batch_timeout?: number;
        max_retries: number;
        max_concurrency?: number;
        dead_letter_queue: string;
      }>;
    };
    triggers: { crons: string[] };
    vars: Record<string, string>;
  };

  it('keeps Wrangler and OpenTofu cron schedules synchronized', () => {
    const wranglerCrons = wrangler.triggers.crons;
    const terraform = read('infra/cloudflare/main.tf');
    const cronResource = terraform.slice(terraform.indexOf('resource "cloudflare_workers_cron_trigger" "application"'));
    const terraformCrons = quotedValuesBetween(cronResource, 'schedules = [', ']');

    expect(new Set(terraformCrons)).toEqual(new Set(wranglerCrons));
    expect(terraformCrons).toHaveLength(wranglerCrons.length);
  });

  it('keeps destination verification bindings and delivery settings synchronized', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const producerBindings = new Map(wrangler.queues.producers.map((binding) => [binding.binding, binding.queue]));
    const consumer = wrangler.queues.consumers.find(({ queue }) => queue === 'intern-notifs-destination-verification');

    expect(producerBindings.get('DESTINATION_VERIFICATION_QUEUE')).toBe('intern-notifs-destination-verification');
    expect(producerBindings.get('DESTINATION_VERIFICATION_DLQ')).toBe('intern-notifs-destination-verification-dlq');
    expect(wrangler.browser.binding).toBe('DESTINATION_BROWSER');
    expect(wrangler.vars.DESTINATION_VERIFICATION_QUEUE_ID).toBeTruthy();
    expect(consumer).toEqual({
      queue: 'intern-notifs-destination-verification',
      max_batch_size: 20,
      max_batch_timeout: 60,
      max_retries: 2,
      dead_letter_queue: 'intern-notifs-destination-verification-dlq',
    });

    expect(terraform).toContain('message_retention_period = each.key == "destination-verification" ? 604800 : 86400');
    expect(terraform).toContain('{ name = "DESTINATION_VERIFICATION_QUEUE", type = "queue"');
    expect(terraform).toContain('{ name = "DESTINATION_VERIFICATION_DLQ", type = "queue"');
    expect(terraform).toContain('{ name = "DESTINATION_BROWSER", type = "browser" }');
    expect(terraform).toContain('{ name = "DESTINATION_VERIFICATION_QUEUE_ID", type = "plain_text"');
    expect(terraform).toContain('batch_size = each.key == "destination-verification" ? 20 : 1');
    expect(terraform).toContain('max_retries      = each.key == "gmail" ? 5 : 2');
    expect(terraform).toContain('max_wait_time_ms = each.key == "destination-verification" ? 60000 : 5000');
  });

  it('keeps GitHub ingestion serialized in Wrangler and OpenTofu', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const consumer = wrangler.queues.consumers.find(({ queue }) => queue === 'intern-notifs-github');

    expect(consumer?.max_concurrency).toBe(1);
    expect(terraform).toContain('max_concurrency  = each.key == "greenhouse" ? 2 : 1');
    expect(terraform).not.toContain('contains(["greenhouse", "github"], each.key) ? 2 : 1');
  });
});
