# InternNotifs

InternNotifs is a public Expo app and serverless backend for discovering internships, receiving native iOS/Android alerts, and privately tracking applications. The catalog is shared; accounts, filters, devices, profile data, documents, and application records are scoped to the Cognito user.

## What ships

- Expo iOS/Android client in [`mobile/`](mobile/) with email-verified Cognito sign-up/sign-in, first-launch alert/filter setup, search feed, saved application tracking, guided official-form apply, and a reusable application profile.
- Public `GET /jobs` and `GET /jobs/{jobId}` endpoints with cursor pagination; Cognito-protected `/me/*` endpoints for preferences, Expo device tokens, profile, documents, applications, and account deletion.
- Polling keeps every open listing in a DynamoDB open-jobs index. New listings fan out only to users whose saved filters match; Expo tickets and receipts make retries safe and invalid device tokens are deactivated.
- Applicant documents are private, versioned S3 objects encrypted with KMS. User data is in a separate encrypted DynamoDB table. The legacy `Applications` table is left intact.
- A partner-adapter interface protects direct submit. No employer is enabled by default: all roles open their official form in the in-app browser and the applicant submits it themselves.

## Deploy the backend

1. Install Node 22 dependencies: `npm install`.
2. Bootstrap AWS: `npx cdk bootstrap aws://ACCOUNT_ID/us-east-1`.
3. Deploy: `npx cdk deploy -c githubRepository=OWNER/REPO -c emailAddress=you@example.com`.
4. Store the encrypted runtime configuration. Email digest is intentionally unchanged and remains the deployment owner’s digest:

   ```bash
   aws ssm put-parameter --name /intern-notifs/runtime-config --type SecureString --overwrite \
     --value '{"sesFrom":"you@example.com","sesTo":"you@example.com"}'
   ```

   In the SES sandbox, both addresses must be verified.

The stack outputs `PublicApiUrl`, `UserPoolId`, and `UserPoolClientId`. Set these values as `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_COGNITO_USER_POOL_ID`, and `EXPO_PUBLIC_COGNITO_CLIENT_ID` before running the mobile project.

## Run the mobile client

```bash
cd mobile
npm install
EXPO_PUBLIC_API_URL=https://... EXPO_PUBLIC_COGNITO_USER_POOL_ID=... EXPO_PUBLIC_COGNITO_CLIENT_ID=... npx expo start
```

Use a physical iOS/Android device for push testing. Expo Push Service delivery is asynchronous: the scheduled poll reconciles Expo receipts and removes `DeviceNotRegistered` tokens.

## Privacy and release checklist

- Keep the App Store/Play privacy policy and terms URLs current before submission; describe account, profile, document, and application-data handling accurately.
- Verify account and document deletion in a deployed environment. Deletion removes user records, document objects, and the Cognito account.
- Test Cognito verification, notification permission denial/approval, notification deep links, pagination, cross-account API authorization, and physical-device push behavior.
- Do not enable a partner adapter until the employer has authorized the integration, supplied credentials and test jobs, and approved the required-field mapping.

## Commands

`npm run typecheck`, `npm run lint`, and `npm test` verify the backend and infrastructure. `npx tsx src/cli.ts seed` baselines sources quietly; `poll`, `dry-run`, `digest`, `smoke-push`, and `smoke-email` remain available for operations. `smoke-push` uses `EXPO_PUSH_TOKEN`.
