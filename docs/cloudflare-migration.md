# Cloudflare migration runbook

## Status and invariants

The Cloudflare replacement is the active development backend and the production
EAS environment targets its Worker. AWS stays untouched until its suspended
account is reactivated and any useful development data is exported. Existing
Cognito passwords cannot be migrated, so people who want account-backed data
must create a fresh InternNotifs account; browsing and device alerts need none.

The migration preserves these product rules:

- the catalog remains public;
- anonymous installations own push alerts and settings; accounts are required only for profiles, documents, and synced application tracking;
- employer applications still hand off to the official form;
- private documents remain accessible only to their owner;
- source admission, reconciliation, notification, and operator-control behavior remains provider-neutral.

## Service mapping

| AWS implementation | Cloudflare replacement |
| --- | --- |
| API Gateway + Lambda | Workers fetch handler |
| Cognito | D1-backed verified email/password accounts and opaque sessions |
| DynamoDB catalog and user tables | D1 indexed JSON records |
| S3 applicant documents | Private R2 bucket served through authenticated Worker routes |
| FIFO SQS and dead-letter queues | Four provider/source Queues with per-source idempotent checkpoints and DLQs |
| EventBridge Scheduler | Workers Cron Triggers |
| CloudWatch application state | Workers observability plus durable D1 source health |
| SSM and Secrets Manager | Worker secret bindings |
| SES | Resend for verification and optional owner digest email |
| CDK | Cloudflare provider v5 Terraform in `infra/cloudflare/` |

Cloudflare Queues do not promise SQS FIFO message-group semantics. The provider
workers therefore keep the existing source-level checkpoints, deterministic
outbox IDs, and idempotent upserts as the correctness boundary.

The ingestion Worker requires the Workers Paid plan: source polls can exceed
the free plan's CPU and subrequest ceilings. D1 has a hard 10 GB size per paid
database, so storage growth must be monitored before public scale.

## Local verification

```bash
npm ci
npm run typecheck
npm test
npm run build:cloudflare
npm run cloudflare:migrate:local
cp .dev.vars.example .dev.vars
npx wrangler dev --local
```

Use throwaway local values in `.dev.vars`. The file is ignored. Wrangler can
also read the repository `.env`; never place AWS credentials or production
secrets in Worker variables.

## Provision infrastructure

Create a scoped Cloudflare API token with account permissions for Workers
Scripts, D1, R2, Queues, and Workers Tail/observability. Add Zone/DNS edit only
when Terraform will attach a custom API hostname.

```bash
export CLOUDFLARE_API_TOKEN='set-in-your-shell-or-secret-manager'
export TF_VAR_cloudflare_account_id='cloudflare-account-id'
export TF_VAR_public_api_url='https://api.example.com'
export TF_VAR_api_hostname='api.example.com'
export TF_VAR_zone_id='cloudflare-zone-id'

npm run build:cloudflare
tofu -chdir=infra/cloudflare init
tofu -chdir=infra/cloudflare plan -out=.context/cloudflare.tfplan
tofu -chdir=infra/cloudflare apply .context/cloudflare.tfplan
```

Do not put the token, account identifiers, email addresses, or secret values in
committed `.tfvars`. Configure a remote encrypted Terraform backend before a
second operator or CI starts applying infrastructure.

## Initialize D1 and secrets

After apply, replace the placeholder `database_id` in a temporary copy of
`wrangler.jsonc` with `tofu -chdir=infra/cloudflare output -raw d1_database_id`,
then apply `cloudflare/migrations/` with that temporary configuration. Do not
commit the generated configuration.

Create separate random secrets for user sessions and operator access:

```bash
npx wrangler secret put AUTH_SESSION_SECRET --name intern-notifs
npx wrangler secret put OPERATIONS_SHARED_SECRET --name intern-notifs
npx wrangler secret put RESEND_API_KEY --name intern-notifs
```

Set `auth_dev_mode=false` before any non-development deployment. `true` returns
the email confirmation code in the signup response and is intentionally local/dev
only. `AUTH_FROM_EMAIL` must be a sender verified by the configured mail service.

## AWS export and backfill

Once AWS reactivates account `628031636041`:

1. Validate `aws sts get-caller-identity --profile intern-notifs`.
2. Export the retained `Internships` and `UserData` tables and the applicant
   documents bucket before changing traffic.
3. Keep the exports under `.context/` or encrypted object storage; they contain
   private data and must never be committed.
4. Re-run every source through the Cloudflare queues. This is the preferred
   catalog backfill because current source snapshots reconstruct canonical jobs.
5. Import only development user profiles/applications/documents that are still
   useful. Cognito password material cannot be exported, so those users create
   fresh Cloudflare credentials.

If AWS data remains inaccessible, source polling rebuilds the public catalog.
The accepted development fallback is to recreate user accounts and omit stale
private records rather than weaken authentication or copy unverified data.

## Cost guards

Cloudflare budget alerts are informational and are not hard spending limits.
The Worker therefore keeps its paid-plan blast radius deliberately small:

- 30,000 ms of CPU and 10,000 subrequests per invocation, enough for a bounded
  multi-document community-source poll; Cloudflare does not bill subrequests,
  and the paid plan's included CPU allocation remains the account-level guard;
- one queued source job at a time, with batches of one and two retries;
- five private documents per user and 100 documents account-wide;
- 5 MiB per document and 1,000 R2 uploads per UTC calendar month.

These application limits do not cap billable inbound Worker requests. Keep the
account-wide $1, $3, and $5 budget alerts enabled and investigate the first
warning rather than waiting for the billing cycle to close.

The $5 alert also targets a generic webhook at
`/internal/billing-shutdown`. Cloudflare authenticates it with the
`cf-webhook-auth` header. When invoked, the Worker latches
`billing_shutdown=stopped` in D1, removes every application queue consumer,
clears the Worker schedules, and disables its workers.dev subdomain. The D1
latch makes scheduled, queued, and HTTP work fail closed even if a management
API call is delayed. Test webhook payloads are ignored; shutdown requires the
signed `billing_budget_alert` payload for the named $5 policy and account.

To recover after reviewing the bill, reapply `infra/cloudflare` to restore the
subdomain and consumers. The provider does not currently detect an externally
emptied cron list, so restore the schedules explicitly, then clear the latch:

```sh
npx wrangler triggers deploy --name intern-notifs \
  --config .context/wrangler.remote.json

npx wrangler d1 execute intern-notifs-db --remote \
  --config .context/wrangler.remote.json \
  --command "DELETE FROM system_state WHERE key = 'billing_shutdown'"
```

Terraform deliberately keeps Worker secret bindings; recovery does not require
rotating the shutdown credentials.

## Cutover and rollback

Before changing the mobile build, verify public catalog paging, sign-up and
verification, sign-in, account deletion, notification registration, R2 document
upload/download, all three provider queues, DLQs, Cron events, and operations
replay against the deployed Worker.

Set `EXPO_PUBLIC_API_URL` to the Cloudflare custom hostname and produce a test
build. Keep AWS retained and the previous mobile configuration available during
the observation window. Rollback changes the mobile/API hostname back to the AWS
endpoint; it does not delete Cloudflare or AWS data.

Only after the observation window and an owner-approved export should AWS
schedules be disabled. Destruction of retained DynamoDB tables, Cognito users,
or S3 documents is a separate, explicit operation and is not part of cutover.

## Recover notification markers consumed before device registration

The notification drain leaves jobs pending while D1 has no user with both an
active Expo device and completed, enabled alert preferences. If an older Worker
already consumed markers without creating a delivery receipt, use the guarded
operations endpoint after deploying the fix and completing the physical-device
alert check.

First preview one bounded batch. Keep the shared secret in the shell and out of
history, logs, and source control:

```bash
read -s OPERATIONS_SHARED_SECRET
curl --fail-with-body --silent --show-error \
  -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"since":"2026-08-25T00:00:00.000Z","limit":10}' \
  https://intern-notifs.jdkrasnick.workers.dev/internal/recover-notifications
unset OPERATIONS_SHARED_SECRET
```

The preview returns `candidates` plus the ordered `candidateJobIds` array and
changes nothing. Re-run the same request with `"apply":true` and
`"expectedCandidateJobIds":<the exact preview array>` only after confirming at
least one opted-in physical device is registered. The operation requeues only
open jobs that have a durable notification event and no delivery receipt for
any device; the exact-ID guard rejects a changed candidate set even if its size
is unchanged. Use small batches to avoid a burst of old alerts, and preview
again before each batch until it returns zero.

### Migrate legacy account-owned mobile alerts

The first signed-in launch after this release checks for a legacy account alert
preference. If the installation already has alerts, it only retires the legacy
flag. Otherwise, on a physical device with notification permission, the client
registers that device's current Expo token to its anonymous installation,
copies the legacy filter and alert settings, and only then disables the retired
account alert flag. Every step is idempotent, and a failed attempt leaves the
account flag in place for a later launch. Do not move device rows between users
manually: an installation observed in D1 may belong to a simulator or a
different device.
