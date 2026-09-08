# Shadow extraction

The shadow extraction queue evaluates exact official posting descriptions without
changing catalog values, admission decisions, destination checks, notifications,
or repair plans. It is intentionally disabled by default.

## Data flow and safety boundary

`destination-verification` first validates the exact posting identity and
persists its normal catalog observation. It then writes a bounded normalized
description to the private `intern-notifs-shadow-extraction` R2 bucket and
enqueues only a compact reference: posting IDs, source identity, content hash,
versioned cache key, and R2 object key. Queue messages never contain the source
description, prompts, user data, credentials, or an arbitrary URL to fetch.

The consumer validates the message and its artifact hash, deduplicates by
content hash plus model/prompt/schema/preprocessing versions, and records run
state in D1. A later artifact revision becomes current before it is queued; a
late result for an old revision is marked `obsolete` and cannot replace it.
Results remain in `shadow_extraction_*` tables, separate from deterministic
role metadata and public catalog tables.

The request contract combines classification and extraction. Factual fields
retain `value` or `null`, `present`/`not-stated`/`conflicting`/`incomplete`,
verbatim supporting passages, and qualifiers. The runtime validator rejects
missing passages, malformed outputs, unsupported currency/period values, and
numeric inconsistencies. Passing JSON or a model confidence value does not make
a result employer-authoritative.

## Cost guard and rollout

`SHADOW_EXTRACTION_ENABLED` remains `false`. No Worker AI binding or production
model is selected here: the model ID is deliberately `unapproved-pilot-model`
until the frozen pilot identifies an eligible model and field set.

When a later approved rollout enables execution, it must provide both
`SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS` (the forecast for all existing
Cloudflare usage) and `SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS`. The consumer
fails closed unless cumulative reservations and reconciled actual usage fit both
the shadow headroom and the combined $20/month cap. A single request can finish
slightly above its conservative reservation, but that actual usage reduces later
capacity. It retries one transient delivery
with a five-minute delay; malformed output is a visible `invalid-output` state,
not a repair loop.

Use the authenticated, read-only endpoint below for aggregate run states,
latency, cost totals, version distribution, and deterministic-baseline differences:

```text
GET /internal/operations/shadow-extraction
```

## Deployment and retention

Apply migration `0020_shadow_extraction.sql` before deploying the queue
consumer. Provision the private R2 bucket and the `shadow-extraction` work/DLQ
queues from the infrastructure configuration. Configure this R2 lifecycle rule
after the bucket exists, using credentials with only the documented R2 write
permission:

```sh
npx wrangler r2 bucket lifecycle add intern-notifs-shadow-extraction shadow-input-30d shadow-input/ \
  --expire-days 30
npx wrangler r2 bucket lifecycle add intern-notifs-shadow-extraction shadow-response-30d shadow-response/ \
  --expire-days 30
npx wrangler r2 bucket lifecycle list intern-notifs-shadow-extraction
```

R2 lifecycle deletion is asynchronous (normally within roughly a day of the
expiry date), so verification must show both prefix rules. Roll back by setting
the enablement variable to `false`; do not remove the migration or delete run
records. The queue consumer then records no model calls and leaves the public
catalog unchanged.

## Field eligibility recommendation

No LLM-derived field is eligible for publication from this PR. Keep all fields
shadow-only until frozen-pilot results demonstrate the approved precision,
recall, unsupported-claim, and combined-cost gates. The first possible future
scope is a reviewed, limited field set with validated quoted evidence; identity,
destination, availability, eligibility, pay, location, and housing remain
non-authoritative until separately approved.
