# Deployment and operations runbook

> The active development backend is Cloudflare while the staged mobile cutover
> is validated. Retained AWS resources remain rollback/export-only and must not
> be deleted. The replacement Worker and Terraform configuration are documented
> in [`cloudflare-migration.md`](cloudflare-migration.md).

## Architecture

InternNotifs is an Expo mobile app with a serverless AWS backend.

| Area | Service / implementation |
| --- | --- |
| Mobile | Expo SDK 55, React Native, iOS first; `mobile/` |
| Authentication | D1-backed verified email/password accounts and opaque sessions |
| Public catalog API | Cloudflare Worker |
| Private user API | Opaque-session-authorized `/me/*` Worker routes |
| Job catalog | D1 indexed canonical records and grouped projections |
| Personal data | D1 user records and releases |
| Résumés | Private R2 objects behind authenticated Worker routes |
| Ingestion and delivery | Cron Triggers, four Queues with DLQs, Worker consumers, Expo Push Service |
| Infrastructure | OpenTofu with Cloudflare provider v5 in `infra/cloudflare/` |
| CI | GitHub Actions in `.github/workflows/ci.yml` |

The catalog is public. Accounts, preferences, device tokens, profiles, documents, and application tracking are private to the verified user identity.

## Catalog quality D1 repair

Deploy the Worker code before inspecting or repairing legacy catalog values. The
command defaults to a read-only scan and reports before/after field counts by
provider, changed/closed/unchanged/unrepairable totals, sample job IDs, and a
deterministic token. Save that complete production report for owner approval:

```bash
export CATALOG_API_URL=https://intern-notifs.jdkrasnick.workers.dev
export OPERATIONS_SHARED_SECRET='use-the-deployed-operations-secret'
npm run migrate:catalog-quality
```

Apply only after approval, with both guards copied from the same dry run. The
Worker rescans before writing, conditionally updates exact JSON values, emits no
outbox events, and refuses stale guards. Any concurrent conflict stops the
grouped projection refresh and requires a new dry run:

```bash
npm run migrate:catalog-quality -- --apply \
  --repair-token EXACT_TOKEN \
  --expected-changed EXACT_COUNT
```

A conflict-free apply rebuilds the grouped projection and includes a verification
audit in its response. Run the standalone dry run once more; it must report zero
changed or closed records. Confirm `GET /jobs`, `GET /catalog`, and a sampled
`GET /catalog/groups/{groupId}` return the preserved job IDs, compact `location`
summaries, structured `locations`, bounded compensation, and unchanged
notification flags. Never store the operations secret in shell history, Git, or
documentation.

Greenhouse, Lever, and Ashby use dedicated half-hour EventBridge schedules,
dispatcher Lambdas, FIFO work queues, two-minute workers, and dead-letter
queues. Published boards are checked every thirty minutes whether active or
quiet; shadow boards are staggered across three-hour checks. See
[`greenhouse/architecture.md`](greenhouse/architecture.md) for the complete
shadow, promotion, retry, and alarm flow.

The seven GitHub community feeds run through the general poll Lambda every ten
minutes. Shadow checkpoints remain isolated and cannot publish jobs or
notifications.

The direct-provider discovery-latency objective is a normal maximum of thirty
minutes from an upstream publication to its next published-board poll. The
GitHub-feed objective is ten minutes, and shadow discovery is intentionally
bounded at three hours. Queue delay, retries, provider backoff, and upstream
timestamp semantics are measured separately from these scheduler objectives.

## Safe operational identifiers

- GitHub: `JDKrasnick/intern-notifs`
- Expo owner/project: `@jdkrasnicks-team/internnotifs`
- EAS project ID: `b9b09ef1-a482-4875-a5f4-ff963488cd3e`
- iOS bundle ID: `com.internnotifs.app`
- App Store Connect app ID: `6792557963`
- AWS Region: `us-east-1`
- Active development API: `https://intern-notifs.jdkrasnick.workers.dev`
- Retained AWS API rollback origin: `https://5dx7gpfa7d.execute-api.us-east-1.amazonaws.com`
- Cognito operations client: the `OperationsUserPoolClientId` output from `InternNotifs`
- Runtime configuration parameter: `/intern-notifs/runtime-config`

These are not credentials. Do not record Apple private keys, API keys, Expo tokens, password values, or personal Apple Account emails here.

## Mobile native project ownership

The iOS project is intentionally checked in and manually managed because it
contains `mobile/ios/InternNotifs/TextInputRecyclingFix.mm`. EAS therefore uses
the committed Xcode project and does not regenerate it from `mobile/app.json`.
Keep the app config and native project synchronized when changing the bundle
identifier, URL scheme, version/build number, device family, orientation,
appearance, icons, splash screen, entitlements, or Expo config plugins. Run
`npx pod-install` after native dependency or plugin changes and verify with a
local iOS build. Expo Doctor's generic `appConfigFieldsNotSyncedCheck` is
disabled for this documented manually managed workflow; its package-version
and all other checks remain enabled.

## Catalog index audit and repair

The public catalog reads DynamoDB's `openJobsIndex`, so the stored job state and
the sparse open/closed index attributes must agree. A daily scheduled audit
checks every canonical job and emits `InternNotifs/Catalog / CatalogIndexMismatchCount`.
The `CatalogIndexMismatchAlarm` warns on any mismatch or a missing daily audit.

Resolve the retained production table from the stack output; never copy a
generated physical table name into scripts or documentation:

```bash
export AWS_PROFILE=intern-notifs
INTERNSHIPS_TABLE="$(aws cloudformation describe-stacks \
  --stack-name InternNotifs \
  --query 'Stacks[0].Outputs[?OutputKey==`InternshipsTableName`].OutputValue | [0]' \
  --output text)"
export INTERNSHIPS_TABLE
```

The command is read-only by default. Record its exact `mismatches`, `byKind`,
and `repairToken` result before making changes:

```bash
npm run audit:catalog-index
```

Repair is deliberately guarded by that count and token. It rescans the whole
table and refuses to write if the affected records or their relevant state
changed between commands. Each index repair is also a narrow conditional update,
so a concurrent catalog write is preserved and makes the repair stop for a fresh
audit instead of being overwritten:

```bash
npm run migrate:open-index -- --repair --expected-mismatches EXACT_COUNT --expected-repair-token EXACT_TOKEN
npm run audit:catalog-index
```

After deploying catalog search, backfill the normalized search text and source
classes once so roles imported before the release are searchable immediately:

```bash
npm run migrate:catalog-search -- --apply
```

The final audit must report zero mismatches. It verifies that open technical
jobs use `openPk=OPEN` and `recency-rank#catalogVisibleAt#jobId` as `openSk`,
closed technical jobs use `closedPk=CLOSED` and `lastSeenAt#jobId` as `closedSk`,
and nontechnical jobs use neither sparse index. Finally, paginate `GET /jobs` to
exhaustion and confirm the repaired job IDs occur in the response; preserve each
returned `cursor` as the next request's `cursor` query parameter.

### 2026-08-09 Ashby catalog-recency repair

Run this one-time repair after deploying catalog-recency-aware code. It selects
only quiet, unnotified jobs created on 2026-08-09 whose first exact source
attachment is one of the reviewed Ashby sources. An Ashby occurrence later
attached to an existing community job is not a candidate.

The default mode is read-only. Save the exact `candidates`, `candidateJobIds`,
and deterministic `repairToken` output:

```bash
npm run migrate:catalog-recency
```

Review every candidate, then apply only with the dry-run guards. Each write is a
narrow conditional update and stops if the job, its source attachments, its
notification state, or its timestamps changed concurrently:

```bash
npm run migrate:catalog-recency -- --apply --expected-count EXACT_COUNT --expected-repair-token EXACT_TOKEN
npm run migrate:catalog-recency
```

After an unrestricted apply, the second dry run must report zero candidates.

If review finds any same-day role that was not part of an initial baseline,
rerun the dry run with the exact approved subset by repeating
`--candidate-job-id JOB_ID` for every approved job. Use the count and token from
that narrowed dry run, and repeat the same job-ID arguments on apply. The command
rejects IDs that are no longer candidates, so a typo or stale selection cannot
silently broaden the repair.

```bash
npm run migrate:catalog-recency -- --candidate-job-id JOB_1 --candidate-job-id JOB_2
npm run migrate:catalog-recency -- --apply --candidate-job-id JOB_1 --candidate-job-id JOB_2 \
  --expected-count 2 --expected-repair-token NARROWED_TOKEN
```

After a narrowed apply, an unrestricted dry run must list exactly the reviewed
and intentionally excluded IDs; the approved IDs are no longer candidates.
Next run the catalog-index audit and guarded open-index repair described above so
all legacy normal rows receive explicit metadata and ranked keys. Verify
`GET /jobs` page by page: normal roles must appear newest-first before all
baseline roles. Also verify a signed-in opening interval does not return any
repaired baseline job IDs. Production execution is an operator action separate
from deployment and this code change.

### Posting identity, receipt, and grouped-catalog migration

Run this guarded migration before enabling the grouped notification stream for
existing users. It scans open catalog roles and every retained delivery receipt,
claims only exact provider/URL aliases, consolidates exact duplicate open rows,
rewrites affected source-occurrence job IDs, and copies receipt tombstones to
the hardened posting key. It also indexes existing opted-in preferences for the
grouped release workers. The migration never creates an outbox event and never
sends a notification.

Validate the assumed role first, then export both physical table names. The
default command is read-only:

```bash
AWS_PROFILE=intern-notifs aws sts get-caller-identity
export AWS_PROFILE=intern-notifs
export INTERNSHIPS_TABLE="$(aws cloudformation describe-stacks --stack-name InternNotifs --query 'Stacks[0].Outputs[?OutputKey==`InternshipsTableName`].OutputValue | [0]' --output text)"
export USERS_TABLE="$(aws cloudformation describe-stacks --stack-name InternNotifs --query 'Stacks[0].Outputs[?OutputKey==`UserDataTableName`].OutputValue | [0]' --output text)"
AWS_PROFILE=intern-notifs npm run migrate:posting-identity
```

Review every reported conflict and the exact duplicate count. Do not apply with
any conflicts. Apply only with the deterministic token from that same dry run:

```bash
AWS_PROFILE=intern-notifs npm run migrate:posting-identity -- \
  --apply --expected-repair-token EXACT_TOKEN
```

The apply is idempotent: alias claims converge on the preserved oldest job,
colliding receipt rows select the strongest delivery tombstone deterministically,
and legacy receipt rows remain available during rollback. Application collisions
retain the furthest workflow state rather than allowing a newer saved/applied
alias to erase interview or offer progress. Catalog rewrites and duplicate
deletes are conditional on the dry-run snapshot, so concurrent ingestion stops
the apply and requires a fresh token instead of being overwritten. After the infrastructure deployment,
wait for `CatalogGroupProjectionSchedule` or invoke the notifier once with
`{"command":"refresh-catalog-groups"}`. Verify `GET /catalog?limit=1` and one
returned `/catalog/groups/{groupId}` before enabling an owner cohort.
Set the deployment parameter to a comma-separated list of reviewed Cognito user
IDs for that cohort. The main stack publishes the same versioned cohort to
`/intern-notifs/grouped-notification-user-ids`; the Greenhouse, Lever, and Ashby
workers read that parameter so a cohort user cannot receive both legacy and
grouped delivery. Leave it blank to keep every user on legacy delivery; use `*`
only after cohort measurement approves the global cutover. Every legacy and
grouped sender reads this same SSM value at runtime. First deploy the new code
with an empty cohort, then deploy all three provider stacks. Wait for in-flight
poll and delivery queues to drain before the final parameter-only activation so
one discovery event cannot straddle the cohort boundary:

```bash
npm run cdk -- deploy InternNotifs --parameters GroupedNotificationUserIds=
npm run cdk -- deploy InternNotifsGreenhouse InternNotifsLever InternNotifsAshby
npm run cdk -- deploy InternNotifs --parameters GroupedNotificationUserIds=OWNER_COGNITO_USER_ID
```

## Notification delivery log

Delivery receipts are the durable record of attempted Expo pushes. Reconstruct
the privacy-safe delivery timeline by resolving the retained tables from the
`InternNotifs` stack, then running:

```bash
export AWS_PROFILE=intern-notifs
export INTERNSHIPS_TABLE="$(aws cloudformation describe-stacks --stack-name InternNotifs --query 'Stacks[0].Outputs[?OutputKey==`InternshipsTableName`].OutputValue | [0]' --output text)"
export USERS_TABLE="$(aws cloudformation describe-stacks --stack-name InternNotifs --query 'Stacks[0].Outputs[?OutputKey==`UserDataTableName`].OutputValue | [0]' --output text)"
npm run notifications:log -- --since 2026-08-11T00:00:00.000Z
```

Use `--company TikTok` for a case-insensitive company filter and `--limit 100`
to bound returned entries. The report includes current receipt status, the full
role identity, the title users saw, source IDs, strong duplicate application
identities, softer cross-location role families, and repeated rendered titles.
It deliberately excludes user IDs, push tokens, and Expo ticket IDs.

New deployments also emit structured `notification_sent`,
`notification_failed`, `notification_skipped_duplicate`,
`push_receipt_confirmed`, and `push_receipt_failed` CloudWatch events. The
`recipientKey` is a short one-way hash used only to correlate delivery events.

Delivery deduplication uses a confidence ladder. Known Greenhouse, Lever,
Ashby, Workday, TikTok, and ByteDance URLs are keyed by provider and immutable
posting ID, then protected by a conditional DynamoDB claim. Unknown providers
fall back to the fully normalized application URL. Employer/title/season role
families intentionally remain diagnostic-only so regional requisitions are not
silently discarded.

## AWS deployment

Use the configured `intern-notifs` assumed role from the AWS CLI. Confirm the active identity before every deployment:

```bash
aws sts get-caller-identity
```

From the repository root:

```bash
npm install
npm run lint
npm run typecheck
npm test
npx cdk deploy -c githubRepository=JDKrasnick/intern-notifs -c emailAddress=DEPLOYMENT_EMAIL
```

The deployment email and SSM runtime configuration are operational values; retrieve them from the approved AWS/EAS configuration, not from source control. The stack retains durable data resources. Never use destructive CDK commands or replace retained tables/buckets without explicit approval.

### Greenhouse monitoring deployment

Deploy Greenhouse monitoring independently. The stack imports the retained
tables from `InternNotifs` and owns only the Greenhouse scheduler, dispatcher,
queues, worker, alarms, and the source-health operations API.

```bash
INTERNSHIPS_TABLE="$(aws cloudformation describe-stacks \
  --stack-name InternNotifs \
  --query 'Stacks[0].Outputs[?OutputKey==`InternshipsTableName`].OutputValue | [0]' \
  --output text)"
USERS_TABLE="$(aws cloudformation describe-stacks \
  --stack-name InternNotifs \
  --query 'Stacks[0].Outputs[?OutputKey==`UserDataTableName`].OutputValue | [0]' \
  --output text)"

npx cdk diff InternNotifsGreenhouse \
  -c target=greenhouse \
  -c internshipsTableName="$INTERNSHIPS_TABLE" \
  -c usersTableName="$USERS_TABLE" \
  -c emailAddress=DEPLOYMENT_EMAIL

npx cdk deploy InternNotifsGreenhouse \
  -c target=greenhouse \
  -c internshipsTableName="$INTERNSHIPS_TABLE" \
  -c usersTableName="$USERS_TABLE" \
  -c emailAddress=DEPLOYMENT_EMAIL
```

Review the diff before deploying. A Greenhouse-only diff must not replace or
delete resources in `InternNotifs`. The architecture and operating limits are
documented in
[`greenhouse/architecture.md`](greenhouse/architecture.md).

The stack also creates a retained operations secret and a rate-limited,
server-to-server operations API. The private Sites dashboard stores that API
key as `OPERATIONS_API_KEY`; it is never exposed to the browser. Each worker
attempt records raw, eligible, and withheld row counts plus a redacted
diagnostic and the 25 most recent runs. The dashboard lists every official
source, including sources with no current jobs.

Operator sign-in uses the dedicated `OperationsUserPoolClientId` owned by the
durable `InternNotifs` stack. Configure the Sites dashboard's
`OPERATIONS_CLIENT_ID` from that output. Do not reuse the mobile client or move
the operations client into a provider monitoring stack; either change can break
dashboard sign-in during an otherwise unrelated monitoring deployment.

The stack sends one combined Greenhouse, Lever, and main-pipeline monitoring reminder at
9:00 AM America/New_York every Monday. The email uses the existing verified
deployment address and includes current dead-letter depth, failed extractions,
stale or quarantined sources, all application alarms, legacy notification
backlog, and queue depth. The shared dashboard includes the same main-pipeline
alarms, including a warning when a poll exceeds three minutes. It is suppressed
after the shared monthly checklist is complete and resumes automatically in the
next calendar month.

Quarantine is deterministic and conservative: identity/schema failures and
permanent 401/403/404 responses quarantine immediately; broad link, quality, or
empty-response failures quarantine after two consecutive attempts. A clean
attempt restores the source. Zero eligible internships, unrelated jobs, and
single transient transport failures do not quarantine a source.

### Lever monitoring deployment

Reuse the table names resolved above, then deploy the independent Lever
scheduler, dispatcher, queues, worker, and alarms:

```bash
npx cdk diff InternNotifsLever \
  -c target=lever \
  -c internshipsTableName="$INTERNSHIPS_TABLE" \
  -c usersTableName="$USERS_TABLE"

npx cdk deploy InternNotifsLever \
  -c target=lever \
  -c internshipsTableName="$INTERNSHIPS_TABLE" \
  -c usersTableName="$USERS_TABLE"
```

A Lever-only diff must not replace or delete resources in `InternNotifs`.

The Lever stack publishes its work and dead-letter queue URLs under
`/intern-notifs/operations/lever/` in Parameter Store. The existing shared
operations API reads those parameters, so `monitoring.jdkrasnick.com` shows
Greenhouse and Lever sources together and can replay one source without a
provider-specific console. Deploy `InternNotifsGreenhouse` after this change to
grant the shared API access to the Lever queue parameters and action route.

After both monitoring stacks are deployed, confirm:

- the `InternNotifs-Lever` CloudWatch dashboard is present;
- the active-source freshness alarm has data within one scheduler cycle;
- the shared operations pane lists all three official provider fleets; and
- pause, resume, and replay work for one shadow source from each provider;
- the monthly monitoring checklist persists after a refresh; and
- a test invocation of the monitoring reminder reaches the deployment address.

### Ashby monitoring deployment

Ashby is a separate retained-table stack. Review the admission manifest before
deployment; every source must be reviewed and must enter in `shadow`:

```bash
npm run ashby:manifest

npx cdk diff InternNotifsAshby \
  -c target=ashby \
  -c internshipsTableName="$INTERNSHIPS_TABLE" \
  -c usersTableName="$USERS_TABLE"

npx cdk deploy InternNotifsAshby \
  -c target=ashby \
  -c internshipsTableName="$INTERNSHIPS_TABLE" \
  -c usersTableName="$USERS_TABLE"
```

An Ashby-only diff must not replace or delete resources in `InternNotifs`. The
stack publishes queue URLs under `/intern-notifs/operations/ashby/`. Redeploy
`InternNotifsGreenhouse` after the Ashby stack so the shared operations Lambda
has the expanded queue IAM policy and includes Ashby sources.

Use [`ashby-monitoring-runbook.md`](ashby-monitoring-runbook.md) for shadow
verification, recovery, per-board promotion, and rollback. Do not promote a
board merely because deployment succeeded.

## EAS environments

The production EAS environment must have these six public variables:

- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_PRIVACY_URL`
- `EXPO_PUBLIC_TERMS_URL`
- `EXPO_PUBLIC_RETENTION_URL`
- `EXPO_PUBLIC_SOURCE_POLICY_URL`
- `EXPO_PUBLIC_SUPPORT_URL`

Check them without printing their values:

```bash
cd mobile
npx eas-cli@latest env:exec production 'npm run release:check'
```

`mobile/eas.json` uses remote iOS build numbers and the `sdk-55` build image. Do not remove that image: Apple requires the iOS 26 SDK/Xcode 26 generation for uploads.

## Build and TestFlight release

Run from `mobile/` after the target commit is committed and CI is green:

```bash
npx eas-cli@latest env:exec production 'npm run release:check'
npx eas-cli@latest build --platform ios --profile testflight --auto-submit --non-interactive
```

This auto-increments the iOS build number, builds from the current Git commit, and schedules App Store Connect submission. Wait for EAS to finish, then wait for Apple processing (typically several minutes). The Build ID and source commit are visible on the EAS build page.

For a manual submission of an already finished build:

```bash
npx eas-cli@latest submit --platform ios --profile testflight --id BUILD_ID --non-interactive
```

After Apple processing:

1. In App Store Connect → TestFlight, locate the new build.
2. Add it to the intended **Internal Testing** group if it is not automatically available.
3. The tester must accept their App Store Connect invitation and use TestFlight with that same Apple Account. Internal testers do not use redeem codes.
4. Follow [`testflight-checklist.md`](testflight-checklist.md) on a physical iPhone.

## Current release context (2026-08-26)

- Build `1.0.0 (22)` was built from `a838fa4` with the issue #41 trust surface,
  final app icon, policy/support links, signup consent, retention enforcement,
  and production EAS URLs. It was uploaded to and accepted by App Store Connect.
- Production D1 migration `0005_auth_consent.sql` and Worker version
  `29e40ce2-bab7-4276-b196-41d1116d808d` were deployed on 2026-08-26 after a
  successful 10% canary.
- Before the public App Store release, finish physical TestFlight acceptance,
  reconcile the final archive, complete the App Store listing/privacy
  disclosures, and submit the selected build for App Review.

## Physical-device checks agents cannot fake

An agent can verify configuration and automated tests, but a real iPhone/TestFlight session is required to verify:

- notification permission approval and denial;
- receipt of a real Expo push and notification deep link behavior;
- installed icon, splash, and build number;
- user-facing policy/support links; and
- full account deletion against the deployed environment.

Once an owner-installed build registers a push token, an agent may use the AWS CLI/Expo operational workflow to trigger a test push, then the device user confirms delivery and tap behavior.
