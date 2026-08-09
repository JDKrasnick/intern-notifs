# Greenhouse monitoring architecture

![Greenhouse monitoring architecture](architecture.png)

The source is [architecture.mmd](architecture.mmd); a scalable
[SVG rendering](architecture.svg) is included as well.

## Deployment boundary

Greenhouse monitoring is deployed as the independent
`InternNotifsGreenhouse` CDK stack. It owns the scheduler, dispatcher, queues,
worker, and alarms, while importing the retained internships and user tables
by name from the existing `InternNotifs` stack. This separation permits a
Greenhouse-only deployment without modifying the lifecycle of the public API,
operations API, authentication, or durable data resources.

Use the exact deployment procedure in
[`../DEPLOYMENT.md`](../DEPLOYMENT.md#greenhouse-monitoring-deployment). Do not
deploy the main stack as a substitute for a Greenhouse-only change.

## Runtime flow

EventBridge invokes a small dispatcher hourly. The dispatcher
creates one FIFO message for every reviewed Greenhouse board. Each board ID is
its own message group, which prevents overlapping work for the same board while
allowing different boards to run concurrently.

Lambda automatically scales with queue backlog up to four worker invocations.
Each invocation receives at most ten messages and processes them sequentially.
Partial-batch responses return only failed board IDs to SQS.

Shadow and published boards deliberately use different DynamoDB checkpoint
keys. Shadow polling validates API shape, role mapping, source quality, and
eligible application links but never writes jobs or sends alerts. When a board
is promoted, it has no published checkpoint, so its first catalog run becomes a
quiet baseline instead of alerting every role already open.

ETags make unchanged checks cheap. A changed published snapshot passes through
canonicalization, deduplication, official-link validation, DynamoDB storage,
and notification matching. The existing general notifier continues to
reconcile push receipts and the optional ntfy fallback.

## Capacity and failure boundaries

- Schedule: hourly.
- Queue batch size: ten boards.
- Worker maximum concurrency: four.
- Worker timeout: two minutes.
- Queue visibility timeout: six minutes.
- Greenhouse API timeout: eight seconds per request.
- Queue retention: one day.
- Dead-letter retention: fourteen days.
- Dead-letter threshold: four receives.

CloudWatch alarms cover worker invocation errors, queue work older than ten
minutes, and any message arriving in the Greenhouse dead-letter queue.
