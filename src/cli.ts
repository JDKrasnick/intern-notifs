#!/usr/bin/env node
import { defaultSources } from './sources/github.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, MemoryInternshipStore } from './store.js';
import { NtfyPublisher, sendDigest, sendPendingNotifications, SesEmailSender } from './notifications.js';
import { parseJobFilter } from './core/filters.js';

const command = process.argv[2];
const table = process.env.INTERNSHIPS_TABLE;
const requiresTable = command === 'poll' || command === 'seed' || command === 'digest';
if (requiresTable && !table) throw new Error('INTERNSHIPS_TABLE is required');
const store = command === 'dry-run' ? new MemoryInternshipStore() : new DynamoInternshipStore(table ?? 'unused-for-smoke-tests');

async function main() {
  if (command === 'poll' || command === 'seed' || command === 'dry-run') {
    const filter = process.env.JOB_FILTER_JSON ? parseJobFilter(JSON.parse(process.env.JOB_FILTER_JSON)) : undefined;
    const report = await new Poller(defaultSources, store, () => new Date(), filter).poll({ seedOnly: command === 'seed' || command === 'dry-run' });
    if (command === 'poll' && process.env.NTFY_TOPIC) console.log(JSON.stringify({ poll: report, notifications: await sendPendingNotifications(store, new NtfyPublisher(process.env.NTFY_TOPIC), { titleTemplate: process.env.NTFY_TITLE_TEMPLATE, descriptionTemplate: process.env.NTFY_DESCRIPTION_TEMPLATE, roleAbbreviations: process.env.NTFY_ROLE_ABBREVIATIONS ? JSON.parse(process.env.NTFY_ROLE_ABBREVIATIONS) : undefined }) }, null, 2));
    else console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
    return;
  }
  if (command === 'digest') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    console.log(`Digested ${await sendDigest(store, new SesEmailSender(process.env.SES_FROM, process.env.SES_TO))} jobs`); return;
  }
  if (command === 'smoke-push') {
    if (!process.env.NTFY_TOPIC) throw new Error('NTFY_TOPIC is required');
    await new NtfyPublisher(process.env.NTFY_TOPIC).publish({ title: 'Intern notifier', body: 'Push delivery is configured.' }); return;
  }
  if (command === 'smoke-email') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    await new SesEmailSender(process.env.SES_FROM, process.env.SES_TO).send('Intern notifier smoke test', 'Email delivery is configured.', '<p>Email delivery is configured.</p>'); return;
  }
  throw new Error('Usage: poll | seed | dry-run | digest | smoke-push | smoke-email');
}
void main();
