# Internship notifications

Personal, serverless internship discovery for public GitHub lists. The first successful sync of each source is intentionally quiet; only subsequently discovered, actionable listings generate a phone push notification. Duplicate applications are merged by normalized apply URL and then by company/title/location/season.

## What is included

- GitHub Markdown adapters for the listed 2026/2027 internship feeds, conditional ETag fetches, safe GFM-table parsing, salary normalization, and layout-drift protection.
- DynamoDB-backed source checkpoints and canonical internships, ntfy phone push notifications, SES HTML/plain-text digests, and an applications-table schema for later use.
- EventBridge Scheduler → Lambda production runtime, plus GitHub Actions CI/manual smoke workflows, CLI commands, and unit/CDK tests.

## One-time setup

1. Install Node 22 and dependencies: `npm install`.
2. Bootstrap your AWS account once: `npx cdk bootstrap aws://ACCOUNT_ID/us-east-1`.
3. Deploy, replacing both values: `npx cdk deploy -c githubRepository=OWNER/REPO -c emailAddress=you@example.com`. For repositories created after July 15, 2026, GitHub uses immutable OIDC subjects; additionally pass `-c githubOwnerId=OWNER_ID -c githubRepositoryId=REPOSITORY_ID` (obtain the numeric IDs with `gh api user --jq .id` and `gh api repos/OWNER/REPO --jq .id`). If your account already has GitHub's OIDC provider, pass `-c existingOidcProviderArn=arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com`.
4. Store the production runtime configuration as an encrypted SSM SecureString named `/intern-notifs/runtime-config` (the Lambda reads only its name, never the values from source control):

   ```bash
   aws ssm put-parameter --name /intern-notifs/runtime-config --type SecureString --overwrite \
     --value '{"ntfyTopic":"a-long-random-private-topic","ntfyTitleTemplate":"{title} — {company}","ntfyDescriptionTemplate":"{location} · {season}{compensationDetail}\n{url}","sesFrom":"you@example.com","sesTo":"you@example.com"}'
   ```

   Install [ntfy](https://ntfy.sh/) on the phone and subscribe to that exact topic. Treat the topic as a secret: anyone who knows it can read and publish messages. Use the same verified SES address for sender and recipient while SES remains in its sandbox.

   The defaults make a compact phone notification: its title is `Short role — Company` (for example, `SWE — Acme` or `ML — Acme`). Its description has location, season, pay when known, specific inferred focus labels, posting date when a source supplies one, and the apply link. Each user can change `ntfyTitleTemplate` and `ntfyDescriptionTemplate` without a redeploy. Valid placeholders are `{title}`, `{shortTitle}`, `{company}`, `{location}`, `{season}`, `{compensation}`, `{compensationDetail}`, `{focus}`, `{posted}`, `{postedDetail}`, `{source}`, and `{url}`. Focus is deterministic title-keyword matching, not an invented qualification list: AI/ML (LLM/NLP/vision), Cloud/Infra (platform/DevOps/SRE/distributed systems), Security, Data, Backend/API, Frontend/Mobile, Systems/Hardware, Quant/Fintech, Product, Design, or general SWE. For example, `"{company}: {title}"` keeps the full title; `"{location}\n{compensation}\n{url}"` keeps the description extra short. `ntfyRoleAbbreviations` can add or override the default role aliases (`software engineering` → `SWE`, `machine learning` → `ML`, `artificial intelligence` → `AI`, `data science` → `DS`, `product management` → `PM`, `quantitative` → `Quant`). Tapping an individual alert opens its application URL.

   The alert emoji is also inferred: SWE uses `computer`, AI/ML uses `brain`, quant uses `chart_with_upwards_trend`, product uses `clipboard`, and design uses `art`. Alerts without a recognized focus have no emoji.

   Job filtering is configured in the same parameter. The default personal setting is `"jobFilter":{"excludeCategories":["grad"]}`, which retains graduate listings for reference but never pushes or digests them. `includeCategories` and `excludeCategories` accept `ai-ml`, `grad`, `swe`, `quant`, `product`, and `design`; `includeKeywords` and `excludeKeywords` are case-insensitive terms matched against company, title, location, and season. An inclusion list means “only these”; exclusions always win. For example: `"jobFilter":{"includeCategories":["ai-ml","quant"],"excludeKeywords":["senior"]}`.
5. GitHub variables/secrets are optional and support manual workflow smoke tests only. For those, put the output `GitHubActionsRoleArn`, `Region`, and `InternshipsTableName` in `AWS_ROLE_ARN`, `AWS_REGION`, and `INTERNSHIPS_TABLE`; add `NTFY_TOPIC`, `JOB_FILTER_JSON`, `SES_FROM`, and `SES_TO` as secrets.
6. Run `npx tsx src/cli.ts seed` once (with the table environment variable) to explicitly baseline feeds, then run `smoke-push` and `smoke-email` before enabling schedules.

SES requires its sending identity to be [verified](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html); in the SES sandbox recipients must be verified too.

## CLI

`poll`, `seed`, `dry-run`, `digest`, `smoke-push`, and `smoke-email` are available through `npx tsx src/cli.ts COMMAND`. `seed` makes an explicit quiet baseline. `dry-run` parses every source using an in-memory store and makes no AWS writes or notifications.

## Schedules and safety

EventBridge Scheduler invokes the Lambda poll every five minutes offset from the top of the hour, and invokes digest jobs directly at 09:00 and 17:00 `America/New_York`. Schedules are DST-aware, retry twice for up to one hour, and send exhausted events to the provisioned SQS dead-letter queue. GitHub Actions remains for CI and manual smoke runs, avoiding its scheduled-workflow delay/drop and public-repository inactivity limitations. Standard GitHub-hosted runners are free for public repositories under [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

The OIDC trust permits only `OWNER/REPO`'s `main` branch and follows [GitHub's AWS OIDC model](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-aws). Push delivery is intentionally at-least-once: if ntfy accepts a message but DynamoDB recording fails, a retry can cause one duplicate.
