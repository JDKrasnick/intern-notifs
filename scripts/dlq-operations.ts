const apiUrl = process.env.OPERATIONS_API_URL?.replace(/\/$/u, '');
const key = process.env.OPERATIONS_API_KEY;
if (!apiUrl || !key) throw new Error('OPERATIONS_API_URL and OPERATIONS_API_KEY are required');

const [operation, queue, selection, reason] = process.argv.slice(2);
if (!operation || !queue) throw new Error('Usage: npm run dlq -- <inspect|plan|apply> <queue> [selection] [reason]');
let body: Record<string, unknown>;
if (operation === 'inspect') body = { operation, queue, limit: selection ? Number(selection) : 25 };
else if (operation === 'plan') {
  const messageIds = (selection ?? '').split(',').filter(Boolean);
  const action = process.env.DLQ_ACTION;
  body = { operation, queue, action, messageIds, expectedCount: messageIds.length, reason };
} else {
  body = { operation, planId: queue, repairToken: selection, expectedCount: Number(reason) };
}
const response = await fetch(`${apiUrl}/internal/operations/dlq`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': key }, body: JSON.stringify(body),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
