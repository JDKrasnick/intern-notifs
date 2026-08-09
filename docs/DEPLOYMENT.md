# Deployment and operations runbook

## Architecture

InternNotifs is an Expo mobile app with a serverless AWS backend.

| Area | Service / implementation |
| --- | --- |
| Mobile | Expo SDK 55, React Native, iOS first; `mobile/` |
| Authentication | Amazon Cognito User Pool; email/password with verified email |
| Public catalog API | API Gateway HTTP API + Lambda |
| Private user API | Cognito JWT-authorized `/me/*` API routes |
| Job catalog | DynamoDB `Internships` table and open-jobs index |
| Personal data | Encrypted DynamoDB `UserData`; legacy `Applications` retained |
| Résumés | Private, versioned, KMS-encrypted S3 objects with presigned uploads |
| Ingestion and delivery | EventBridge Scheduler, FIFO SQS, bounded Lambda workers, Lambda notifier, Expo Push Service, SSM runtime config |
| Infrastructure | AWS CDK in `infra/intern-notifs-stack.ts` and provider monitoring stacks |
| CI | GitHub Actions in `.github/workflows/ci.yml` |

The catalog is public. Accounts, preferences, device tokens, profiles, documents, and application tracking are private to the Cognito subject.

Greenhouse uses a dedicated ten-minute EventBridge schedule, dispatcher Lambda,
FIFO work queue, two-minute worker, and dead-letter queue. Active boards are
checked every ten minutes; boards whose last successful snapshot had zero
eligible roles are staggered across six-hour checks. See
[`greenhouse/architecture.md`](greenhouse/architecture.md) for the complete
shadow, promotion, retry, and alarm flow.

Lever uses the same FIFO pattern in a separately deployable stack. Both shadow
and published boards are scheduled; shadow checkpoints remain isolated and
cannot publish jobs or notifications.

## Safe operational identifiers

- GitHub: `JDKrasnick/intern-notifs`
- Expo owner/project: `@jdkrasnicks-team/internnotifs`
- EAS project ID: `b9b09ef1-a482-4875-a5f4-ff963488cd3e`
- iOS bundle ID: `com.internnotifs.app`
- App Store Connect app ID: `6792557963`
- AWS Region: `us-east-1`
- Public API: `https://5dx7gpfa7d.execute-api.us-east-1.amazonaws.com`
- Cognito User Pool: `us-east-1_mHbG28HiZ`
- Cognito mobile client: `4vuo4dqidns1fn30q3mhfabopb`
- Cognito operations client: the `OperationsUserPoolClientId` output from `InternNotifs`
- Runtime configuration parameter: `/intern-notifs/runtime-config`

These are not credentials. Do not record Apple private keys, API keys, Expo tokens, password values, or personal Apple Account emails here.

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
- the shared operations pane lists both provider fleets; and
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

The production EAS environment must have these five plaintext/sensitive variables:

- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_COGNITO_USER_POOL_ID`
- `EXPO_PUBLIC_COGNITO_CLIENT_ID`
- `EXPO_PUBLIC_PRIVACY_URL`
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

## Current release context (2026-07-19)

- Build `1.0.0 (4)` was built from merged `main` commit `5d6255e` and is superseded.
- Build `1.0.0 (5)` was built from `d994e00` (`feat: complete TestFlight release readiness`) with policy/support pages, EAS production URLs, icon, splash, and TestFlight checks.
- Before the public App Store release, merge the validated release-readiness work to `main`, finish physical TestFlight acceptance, complete the App Store listing/privacy disclosures, then submit the selected build for App Review.

## Physical-device checks agents cannot fake

An agent can verify configuration and automated tests, but a real iPhone/TestFlight session is required to verify:

- notification permission approval and denial;
- receipt of a real Expo push and notification deep link behavior;
- installed icon, splash, and build number;
- user-facing policy/support links; and
- full account deletion against the deployed environment.

Once an owner-installed build registers a push token, an agent may use the AWS CLI/Expo operational workflow to trigger a test push, then the device user confirms delivery and tap behavior.
