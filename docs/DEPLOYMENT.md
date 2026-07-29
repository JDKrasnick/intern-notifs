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
| Ingestion and delivery | EventBridge Scheduler, Lambda notifier, Expo Push Service, SSM runtime config |
| Infrastructure | AWS CDK in `infra/intern-notifs-stack.ts` |
| CI | GitHub Actions in `.github/workflows/ci.yml` |

The catalog is public. Accounts, preferences, device tokens, profiles, documents, and application tracking are private to the Cognito subject.

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
