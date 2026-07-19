# Internship notifications

Personal, serverless internship discovery for public GitHub lists. The first successful sync of each source is intentionally quiet; only subsequently discovered, actionable listings are texted. Duplicate applications are merged by normalized apply URL and then by company/title/location/season.

## What is included

- GitHub Markdown adapters for the listed 2026/2027 internship feeds, conditional ETag fetches, safe GFM-table parsing, salary normalization, and layout-drift protection.
- DynamoDB-backed source checkpoints and canonical internships, SNS SMS notifications, SES HTML/plain-text digests, and an applications-table schema for later use.
- CDK infrastructure, OIDC-based public-repository workflows, CLI commands, and unit/CDK tests.

## One-time setup

1. Install Node 22 and dependencies: `npm install`.
2. Bootstrap your AWS account once: `npx cdk bootstrap aws://ACCOUNT_ID/us-east-1`.
3. Deploy, replacing both values: `npx cdk deploy -c githubRepository=OWNER/REPO -c emailAddress=you@example.com`. If your account already has GitHub's OIDC provider, pass `-c existingOidcProviderArn=arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com`.
4. Put the output `GitHubActionsRoleArn`, `Region`, and `InternshipsTableName` in repository variables named `AWS_ROLE_ARN`, `AWS_REGION`, and `INTERNSHIPS_TABLE`. Add `SMS_DESTINATION`, `SMS_ORIGINATION_NUMBER`, `SES_FROM`, and `SES_TO` as repository secrets. Use the same verified SES address for both SES secrets while SES remains in its sandbox.
5. Run `npx tsx src/cli.ts seed` once (with the table environment variable) to explicitly baseline feeds, then run `smoke-sms` and `smoke-email` before enabling schedules.

SNS U.S. SMS accounts initially operate in the [SMS sandbox](https://docs.aws.amazon.com/sns/latest/dg/sns-sms-sandbox.html): verify the destination phone, obtain an origination identity, and complete the applicable registration. SES also requires its sending identity to be [verified](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html); in the SES sandbox recipients must be verified too.

## CLI

`poll`, `seed`, `dry-run`, `digest`, `smoke-sms`, and `smoke-email` are available through `npx tsx src/cli.ts COMMAND`. `seed` makes an explicit quiet baseline. `dry-run` parses every source using an in-memory store and makes no AWS writes or notifications.

## Schedules and safety

The poll workflow runs every five minutes offset from the top of the hour and serializes concurrent runs. The digest workflow runs hourly but gates sends to 09:00 and 17:00 `America/New_York`, making it DST-safe despite GitHub cron being UTC-only. GitHub warns that scheduled workflows can be delayed or dropped during high load and disables public-repository schedules after 60 days of inactivity; see its [schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). Standard GitHub-hosted runners are free for public repositories under [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

The OIDC trust permits only `OWNER/REPO`'s `main` branch and follows [GitHub's AWS OIDC model](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-aws). SNS is intentionally at-least-once: if SNS accepts a message but DynamoDB recording fails, a retry can cause one duplicate.
