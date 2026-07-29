# Lever ingestion monitoring plan

## Goal

Detect stale, incomplete, unsafe, or failing Lever sources quickly while
preserving the last trusted catalog and avoiding alerts for harmless transient
failures or normal seasonal changes.

This plan assumes the complete-snapshot boundary described in
`ingestion-architecture.md`, and the shadow/promotion workflow described in
`lever-company-onboarding-plan.md`.

## Current operational gap

EventBridge Scheduler invokes the poll Lambda about every five minutes. The
poller catches an individual adapter failure, appends a string to its report,
and continues. This protects other sources, but the Lambda invocation can still
finish successfully.

The existing Scheduler DLQ therefore detects failed invocation delivery, not a
Lever board that repeatedly timed out, returned malformed JSON, or produced a
rejected snapshot. Checkpoints record successful-fetch data but there is no
durable source-health or incident record.

The project target is for 95% of listed open roles to have been checked within
30 minutes. Monitoring must measure successful trusted snapshots, not merely
Lambda invocations.

## Research facts and operating assumptions

Lever's Postings API is a public published-job feed with global and EU hosts.
Its documentation exposes pagination but does not promise a public-read rate
limit or reliable conditional-GET behavior.

A 2026-07-29 live check found weak ETags on all four configured sources, while
a matching Palantir `If-None-Match` request still returned `200`. Monitoring
must treat a `200` with an unchanged normalized hash as a healthy no-change
result and cannot interpret the absence of `304` as a failure.

Lever's authenticated API documentation recommends exponential backoff for
rate-limited or temporary failures. Even though that quota is not a documented
contract for the public Postings API, bounded backoff and low concurrency are
the safe response to `429` and `5xx`.

Official references:
[Lever Postings API](https://github.com/lever/postings-api) and
[Lever API documentation](https://hire.lever.co/developer/documentation).

## Phase 1 — Persist source health

Store one durable record per Lever source:

```text
sourceId
employerId
provider=lever
region
sourceStatus
lastAttemptAt
lastSuccessAt
lastChangedAt
freshnessMinutes
durationMs
etag
contentHash
rawCount
validCount
eligibleCount
filteredCount
withheldCount
consecutiveFailures
lastOutcome
lastFailureCategory
lastSafeDiagnostic
backoffUntil
incidentState
configVersion
```

Update the attempt fields for every run. Update `lastSuccessAt` only after a
trusted complete fetch or a healthy unchanged result. A rejected snapshot or
caught exception must not look fresh.

Use stable outcomes:

```text
success_changed
success_unchanged_304
success_unchanged_hash
temporary_provider_error
rate_limited
invalid_configuration
not_found
invalid_schema
incomplete_pagination
unexpected_raw_zero
application_host_mismatch
catalog_write_failed
```

Do not store complete provider payloads, descriptions, credentials, applicant
data, or complete application URLs in health records.

### Phase 1 acceptance

- Source health distinguishes "no change" from "could not check."
- A rejected snapshot cannot advance `lastSuccessAt`.
- The last trusted checkpoint and catalog remain intact after failure.
- Health records can be queried by source and provider.

## Phase 2 — Emit structured events and metrics

Use the shared event envelope from `pipeline-observability-plan.md`:

```json
{
  "event": "source_fetch_completed",
  "occurredAt": "2026-07-29T14:02:09.183Z",
  "runId": "aws-request-id",
  "sourceId": "lever-palantir",
  "employerId": "palantir",
  "provider": "lever",
  "region": "global",
  "outcome": "success_changed",
  "durationMs": 184,
  "rawCount": 286,
  "eligibleCount": 3,
  "configVersion": 2
}
```

Retain events for:

- poll start/completion;
- source fetch start/completion/failure;
- snapshot validation/rejection;
- listing create/update/filter/quarantine/closure;
- application-link validation;
- checkpoint and catalog write failure;
- retry, backoff, auto-pause, replay, and incident state changes.

Use safe reason codes and URL host/path classes. Drop URL queries and fragments.
Never log source descriptions or user/application data.

Publish low-cardinality CloudWatch metrics using Embedded Metric Format:

| Metric | Dimensions | Purpose |
| --- | --- | --- |
| `SourceFetchSuccess` | provider, region, outcome | Provider and region health |
| `SourceFetchFailure` | provider, region, category | Failure trends |
| `SourceFetchDurationMs` | provider, region | Latency and timeout tuning |
| `SourceFreshnessMinutes` | provider, region | Freshness SLO |
| `SnapshotRejected` | provider, region, category | Unsafe/incomplete data |
| `RawListingCount` | provider, region | Board-level feed drift |
| `EligibleListingCount` | provider, region | Internship coverage drift |
| `ListingWithheld` | provider, region, reason | URL/quality issues |
| `PollRunFailure` | command | Pipeline health |
| `DeadLetterQueueDepth` | queue | Exhausted invocation/work |

Keep `sourceId`, employer ID, posting ID, and URL out of metric dimensions to
avoid unbounded cardinality. They remain available in structured logs and
health records.

### Phase 2 acceptance

- One poll can be reconstructed by `runId`.
- An operator can explain zero new jobs without reading provider payloads.
- Dashboards separate global and EU failures.
- Metrics remain low-cardinality as companies are added.

## Phase 3 — Alert and retry policy

### Freshness

While the source roster is small, keep published Lever boards on the existing
five-minute poll:

- warning/review event after 15 minutes without a trusted success;
- high-severity freshness incident at 30 minutes;
- suppress duplicate notifications while one incident remains open;
- record provider backoff explicitly, but do not call a backed-off source
  healthy.

A stable empty board can move to a quiet cadence. A board that supports an open
catalog role must stay on a cadence capable of meeting the 30-minute target.

### Fetch failures

| Result | Automatic action | Alert |
| --- | --- | --- |
| One timeout or `5xx` | Bounded retry with exponential backoff and jitter | Log only |
| `429` | Respect `Retry-After` when present; otherwise bounded backoff | Prompt only if repeated/provider-wide |
| Repeated temporary failure | Preserve catalog and open one source incident | Prompt |
| `404` or invalid region/site | Pause for configuration repair | Prompt |
| Malformed JSON/schema/pagination | Reject snapshot and preserve catalog | Prompt |
| Unexpected raw-zero after non-empty | Hold snapshot | Prompt |
| One invalid application link | Withhold the role | Digest |
| Widespread URL mismatch | Reject snapshot/pause source | Prompt |
| Many stale sources/provider outage | Preserve all last-known-good snapshots | Page |
| Catalog unavailable or exhausted work queue | Stop unsafe commits | Page |

Normal changes in eligible-role count, including a move to zero while the raw
board remains valid and non-empty, are review/dashboard signals rather than
automatic outages. Seasonal internship hiring makes such changes plausible.

### Alert contents

Every incident notification includes:

- affected source/provider/region;
- first and most recent failure times;
- last trusted success and counts;
- safe failure category;
- retry/backoff already attempted;
- catalog effect;
- next safe operator action.

Never include raw response bodies, descriptions, credentials, applicant data,
or complete URLs.

### Phase 3 acceptance

- A single transient failure does not page.
- A stale source cannot remain silent beyond the freshness target.
- A single broken board does not hide a provider-wide incident.
- Alert deduplication prevents storms.
- Every alert states whether the catalog was preserved.

## Phase 4 — Live drift detection

Run two complementary checks:

### Deterministic CI contract

On every change:

- validate the registry-to-fixture manifest;
- run every reviewed company's sanitized fixture through the real adapter;
- test pagination, regional URLs, hash stability, error classification, and
  snapshot reconciliation;
- prevent a source or quality policy from being enabled alone.

CI does not depend on live Lever availability.

### Nightly live contract

Run a rate-controlled, read-only check:

- cover at least one reviewed board in each enabled region;
- validate HTTP/JSON shape, unique IDs, pagination completion, and URL
  invariants;
- compare raw/valid/eligible/filter ratios with recent history;
- record ETag behavior without requiring `304`;
- publish only health and safe summaries, never catalog changes.

Escalate a provider-wide schema or regional-host change. Send isolated board
drift to the review queue.

### Phase 4 acceptance

- Fixtures catch code regressions without network access.
- Nightly checks catch upstream contract drift before a normal source causes
  unsafe catalog changes.
- Live checks are bounded and do not create notification events.

## Phase 5 — Recovery controls and runbooks

Provide operator controls to:

- replay one failed source task;
- pause or resume one source;
- change a source's polling tier;
- acknowledge/resolve an incident;
- move a source between shadow and published status through reviewed config;
- inspect the last trusted checkpoint and health record.

When the roster outgrows one Lambda loop, create one queue task per due source.
Use a separate application-level failure queue; the existing Scheduler DLQ
continues to cover failed schedule-to-Lambda delivery.

Create runbooks for:

- global or EU Lever outage;
- `429`/backoff;
- invalid site or region;
- malformed JSON or schema drift;
- incomplete pagination or duplicate IDs;
- unexpected raw-zero;
- application-host mismatch;
- broken application links;
- catalog write failure;
- safe replay and incident resolution.

Exercise replay and alert delivery periodically. Recovery is not considered
ready until it has been tested.

## Final Acceptance Criteria

- Every enabled Lever source has queryable durable health.
- The 30-minute freshness target is measured from trusted snapshots.
- `304` and unchanged hashes are both healthy no-change outcomes.
- Failed or rejected snapshots preserve the previous catalog.
- Temporary, source-specific, provider-wide, and pipeline-wide failures have
  distinct responses.
- Alerts are actionable, deduplicated, and free of sensitive/raw provider data.
- CI and nightly checks cover code regressions and upstream drift separately.
- Operators can pause, replay, and recover one source without redeploying or
  re-fetching every provider.
