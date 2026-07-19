#!/usr/bin/env node
import { defaultSources } from './sources/github.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, MemoryInternshipStore } from './store.js';
import { sendDigest, sendPendingSms, SesEmailSender, SnsSmsPublisher } from './notifications.js';

const command = process.argv[2];
const table = process.env.INTERNSHIPS_TABLE;
const requiresTable = command === 'poll' || command === 'seed' || command === 'digest';
if (requiresTable && !table) throw new Error('INTERNSHIPS_TABLE is required');
const store = command === 'dry-run' ? new MemoryInternshipStore() : new DynamoInternshipStore(table ?? 'unused-for-smoke-tests');

async function main() {
  if (command === 'poll' || command === 'seed' || command === 'dry-run') {
    const report = await new Poller(defaultSources, store).poll({ seedOnly: command === 'seed' || command === 'dry-run' });
    if (command === 'poll' && process.env.SMS_DESTINATION) console.log(JSON.stringify({ poll: report, sms: await sendPendingSms(store, new SnsSmsPublisher(process.env.SMS_DESTINATION, process.env.SMS_ORIGINATION_NUMBER)) }, null, 2));
    else console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
    return;
  }
  if (command === 'digest') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    console.log(`Digested ${await sendDigest(store, new SesEmailSender(process.env.SES_FROM, process.env.SES_TO))} jobs`); return;
  }
  if (command === 'smoke-sms') {
    if (!process.env.SMS_DESTINATION) throw new Error('SMS_DESTINATION is required');
    await new SnsSmsPublisher(process.env.SMS_DESTINATION, process.env.SMS_ORIGINATION_NUMBER).publish('Intern notifier smoke test'); return;
  }
  if (command === 'smoke-email') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    await new SesEmailSender(process.env.SES_FROM, process.env.SES_TO).send('Intern notifier smoke test', 'Email delivery is configured.', '<p>Email delivery is configured.</p>'); return;
  }
  throw new Error('Usage: poll | seed | dry-run | digest | smoke-sms | smoke-email');
}
void main();
