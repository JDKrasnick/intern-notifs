# Ashby monitoring runbook

The `InternNotifsAshby` stack is an independently deployable polling plane over
the retained internship and user tables. It owns a staggered ten-minute
scheduler, dispatcher, encrypted FIFO work queue, worker, work DLQ, scheduler
DLQ, four alarms, a dashboard, and operations-discovery parameters.

## Admission before deployment

Every board must have committed `evidence.json` and metadata-only `probe.json`
fixtures, pass `npm run ashby:manifest`, and enter `reviewedAshbySources` in
`shadow`. Admission is a reviewed code change. There is no mutable runtime
admission endpoint.

The owner must confirm that the employer-controlled careers page contains the
exact `jobs.ashbyhq.com/{board}` URL, the observed company is unambiguous, every
application host is expected, and the qualifying role samples are in product
scope. This approval admits a source only to shadow; it is not promotion.

## Shadow verification

After deployment, use the shared operations API/dashboard to confirm each board
has at least three successful snapshots spanning at least 24 hours. For each
board verify:

- exact Ashby identity and schema, zero malformed rows, and no path violations;
- no unexplained application host and link failures at or below 20%; inspect
  `applicationLinksChecked` and `applicationLinkFailures` for each board;
- reviewed inclusion/exclusion samples and a rehearsed quiet baseline;
- health/checkpoints exist, but there are no catalog, occurrence, outbox,
  user-store, or publisher writes from the shadow run.

Pause and resume one source, issue an operator replay, inspect queue and DLQ
counts, and verify the four Ashby alarms and `InternNotifs-Ashby` dashboard.
Operator pause, backoff, replay, and tier overrides take precedence over the
automatic six-hour quiet cadence.

## Promotion

Promotion is per board. Change only an individually qualified source from
`shadow` to `published`, review the config diff, rerun the manifest and focused
tests, then deploy `InternNotifsAshby`. A single deployment may contain several
independently approved promotions.

Verify that the first published run creates the source checkpoint as a quiet
baseline and creates no notification event. A later genuine addition follows
normal reconciliation and notification behavior. Updates are not new-role
alerts; one complete omission marks a role missing and the second consecutive
complete omission closes it.

## Recovery and rollback

For a bad or stale board, pause it from operations before investigating. Replay
only after checking the diagnostic, provider response, application hosts, and
backoff. Redrive DLQ work only after the underlying condition is fixed; FIFO
message groups preserve per-source ordering.

To roll back publication, change the affected source back to `shadow` and deploy
Ashby. This stops catalog writes without blocking other boards. Do not delete
shared tables, checkpoints, or source occurrences. If the entire fleet is
unsafe, disable the Ashby schedule or pause all Ashby sources, then redeploy or
roll back only `InternNotifsAshby`.
