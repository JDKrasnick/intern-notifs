# API and ingestion Worker split

The public API stays `intern-notifs`. The private ingestion Worker is
`intern-notifs-ingestion`; it has no `workers.dev` or preview URL and is reached
only through the API Worker's `INGESTION` service binding. Both Workers use the
same existing D1 database and existing queues. This is a deployment-boundary
change, not a catalog-policy or schema change.

## Ownership inventory

| Surface | Owner after cutover | Notes |
| --- | --- | --- |
| Public catalog, filters, releases, application tracking, account/auth, installations, résumés, employer APIs, Gmail OAuth callback/API | API Worker | Existing hostname and request paths remain unchanged. |
| `/operations/*`, `/internal/operations/*`, admission, DLQ, backfill, poll-source, catalog-quality, notification recovery, projection refresh, posting-identity repair | Ingestion Worker, forwarded by API Worker | The API checks nothing new for these routes; the existing operations key remains required by the destination handler. A second secret authenticates the API-to-ingestion hop. |
| Billing shutdown webhook | Ingestion Worker, forwarded by API Worker | Existing webhook path and its separate webhook secret remain unchanged. |
| All nine crons | Ingestion Worker only | `*/5`, GitHub, provider, hourly, daily maintenance, and identity-audit schedules are declared only in `wrangler.ingestion.jsonc`. |
| All six queue consumers and DLQs | Ingestion Worker only | Greenhouse, Lever, Ashby, GitHub, Gmail, and destination verification. |
| Request-triggered Gmail checks | API Worker producer | The API retains only the Gmail producer because applying to a role can enqueue delayed checks. |

The API config needs D1, private R2 documents, Gmail producer, auth/email and
Gmail secrets, `OPERATIONS_SHARED_SECRET`, and `INTERNAL_SERVICE_SECRET`. The
ingestion config needs D1, Browser Rendering, every queue producer/consumer,
ingestion/email/Gmail/operations/billing secrets, and the same
`INTERNAL_SERVICE_SECRET`. Do not put either secret in Wrangler config, Git,
logs, shell arguments, or `EXPO_PUBLIC_*`; set it interactively from the
approved secret manager for each Worker.

## Controlled cutover

Only the coordinator performs this procedure. No migration, queue replay,
purge, reset, or historical repair is part of it.

1. Record the API Worker version, all current queue consumers, cron ownership,
   queue/DLQ depths, `GET /operations/sources` response, public `/jobs` and a
   filtered catalog response. Record the exact API and ingestion build SHAs.
2. Create `intern-notifs-ingestion` from the ingestion configuration **with its
   `queues.consumers` and `triggers` temporarily removed**, and with
   `workers_dev=false` and `preview_urls=false` retained. Set the existing
   applicable secrets plus a newly generated shared `INTERNAL_SERVICE_SECRET`
   interactively on both Workers. Confirm the new Worker has no public route,
   cron, or queue consumer.
   The existing destination-verification queue and DLQ predate this Terraform
   ownership entry: import both into the matching `cloudflare_queue.work` and
   `cloudflare_queue.dead_letter` resources before applying an infrastructure
   plan, so OpenTofu never attempts to recreate or replace them.
3. Deploy `wrangler.api.jsonc` to `intern-notifs`. This preserves the public
   hostname while removing its cron and consumer declarations. Verify there is
   now exactly zero active consumer/schedule owners during this intentionally
   short pause; do not trigger backfills or replays in the pause.
4. Deploy the complete `wrangler.ingestion.jsonc`. Confirm each of the six
   queues has exactly one consumer, every cron belongs only to
   `intern-notifs-ingestion`, and no queue backlog was duplicated. The first
   normal scheduled pass processes retained queue messages idempotently.
5. Run the smoke checks below before enabling any optional policy or repair
   work. Keep the deployment versions and queue-owner evidence with the release
   record.

Never deploy both full configurations while the original Worker still owns
crons or consumers. That would create duplicate scheduling and could duplicate
notifications.

## Smoke checks

With `OPERATIONS_SHARED_SECRET` supplied only through the coordinator's secure
environment, verify:

```bash
curl -fsS https://intern-notifs.jdkrasnick.workers.dev/jobs
curl -fsS 'https://intern-notifs.jdkrasnick.workers.dev/jobs?disciplines=Software%20Engineering'
curl -fsS -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  https://intern-notifs.jdkrasnick.workers.dev/operations/sources
curl -fsS -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  https://intern-notifs.jdkrasnick.workers.dev/internal/deployment
```

Also confirm an unauthenticated `/me/*` request remains unauthorized, a
private document remains unavailable without its owner session, operations
without the key return the preexisting hidden response, and the filtered result
does not expand to roles outside the requested filter. The deployment endpoint
reports the API and ingestion roles; record the platform deployment IDs from
the deploy output alongside it.

## Rollback

The rollback is code/configuration-only: D1 and queues remain untouched.

1. Pause the ingestion cron and queue consumers; wait for the single active
   batch to complete or retry naturally. Do not purge or replay queues.
2. Restore the prior API version/configuration (including the original queue
   consumers and cron ownership) only after confirming ingestion owns none.
3. Confirm exactly one owner per queue and cron, then repeat the smoke checks
   and compare public catalog, filter, source-health, outbox, and queue/DLQ
   counts to the recorded baseline.

If the API version is healthy but only the internal forwarding fails, leave
ingestion paused and restore the prior API configuration. Do not roll back or
alter shared D1 schema as part of this procedure.
