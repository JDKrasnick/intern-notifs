#!/usr/bin/env node
import { defaultSources } from './sources/index.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, MemoryInternshipStore } from './store.js';
import { ExpoPushPublisher, sendDigest, SesEmailSender } from './notifications.js';
import { validateApplicationUrl } from './core/application-url.js';

const command = process.argv[2];
const table = process.env.INTERNSHIPS_TABLE;
const requiresTable = command === 'poll' || command === 'seed' || command === 'digest';
if (requiresTable && !table) throw new Error('INTERNSHIPS_TABLE is required');
const store = command === 'dry-run' ? new MemoryInternshipStore() : new DynamoInternshipStore(table ?? 'unused-for-smoke-tests');

async function main() {
  if (command === 'poll' || command === 'seed' || command === 'dry-run') {
    const report = await new Poller(defaultSources, store, () => new Date(), undefined, validateApplicationUrl).poll({ seedOnly: command === 'seed' || command === 'dry-run' });
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
    return;
  }
  if (command === 'digest') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    console.log(`Digested ${await sendDigest(store, new SesEmailSender(process.env.SES_FROM, process.env.SES_TO))} jobs`); return;
  }
  if (command === 'smoke-push') {
    if (!process.env.EXPO_PUSH_TOKEN) throw new Error('EXPO_PUSH_TOKEN is required');
    await new ExpoPushPublisher().publish(process.env.EXPO_PUSH_TOKEN, { title: 'InternNotifs', body: 'Push delivery is configured.', click: 'smoke-test' }); return;
  }
  if (command === 'smoke-email') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    await new SesEmailSender(process.env.SES_FROM, process.env.SES_TO).send('Intern notifier smoke test', 'Email delivery is configured.', '<p>Email delivery is configured.</p>'); return;
  }
  throw new Error('Usage: poll | seed | dry-run | digest | smoke-push | smoke-email');
}
void main();
