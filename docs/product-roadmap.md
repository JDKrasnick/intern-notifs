# InternNotifs product tracker

## Product direction

**Promise:** a calm, mobile-first early-career radar that tells students about credible technical roles quickly and gets them to the official application form with minimal friction.

**Initial audience:** international and domestic undergraduate/graduate students.

**Initial scope:** technical internships, co-ops, apprenticeships, new-grad programs, and explicitly entry-level roles — software engineering, AI/ML, data, infrastructure/cloud, security, quantitative roles, product, and technical design.

**Product constraints:**

- Public browsing and device-scoped push alerts; account only for synced applications and profile.
- Prefer official employer career sources and openly maintained, attributed public lists.
- Never automate a non-partner submission; users review and submit official forms themselves.
- Core experience remains free, simple, privacy-respecting, and suitable for open-source development.

## Milestones

| Milestone | Status | Exit criteria |
| --- | --- | --- |
| Catalog definition | In progress | Continuous employer discovery, source rules, taxonomy, and reliability targets operate without an owner-selected roster |
| Official source adapters | In progress | SQS-backed Greenhouse, Lever, and Ashby runtimes poll reviewed boards; Ashby is collecting production shadow evidence before per-board promotion, while SmartRecruiters remains planned |
| Catalog operations | In progress | Standardized ingestion, shared source-quality gates, durable source health, private live dashboard, source-candidate review queue, and bounded Firecrawl research workflow operate |
| Mobile discovery MVP | In progress | Filtered feed, native deep-link alerts, official-form handoff, and tracker are polished |
| Human-reviewed application assistance | In progress | Headed pilot fills a supported official form, pauses for unknowns and verification, and leaves final submission to the user |
| Headless application preparation | Planned | Isolated runner reuses proven mappings, supports live user handoff, and never bypasses verification or non-partner submission controls |
| Trust and release readiness | In progress | Approved public policies and support routes are live, and the disclosure worksheet, consent, retention enforcement, and release checks are deployed; store-console entry, final archive reconciliation, and physical-device acceptance remain |
| Cloudflare platform migration | In progress | Cloudflare infrastructure is live, the source backfill and grouped D1 projection are verified, the production mobile environment targets the Worker, and retained AWS rollback data is preserved |
| Closed beta | Planned | 30–50 student test cohort and agreed success metrics |
| Public release | Planned | TestFlight/Play validation complete and catalog reliability meets target |

## Immediate backlog

### Codex

- [x] Implement the Cloudflare replacement substrate with Workers, D1, R2, Queues, Cron Triggers, provider v5 Terraform, Cloudflare-native mobile authentication, and local end-to-end smoke coverage.
- [x] Provision the Cloudflare account, apply remote D1 migrations and Worker secrets, verify the source backfill, and cut the production mobile environment over with an AWS rollback window.
- [x] Bound sparse grouped-catalog filter scans, reconcile legacy notification markers through durable Expo receipts, isolate iOS plain-text accessibility state from secure authentication fields, and make account switching/sign-out race-safe with server-side session revocation.
- [x] Roll every configured GitHub board to its live 2027 repository contract, preserve source health across HTTP 304 responses, roll expired list-wide seasons forward, and defer or guardedly recover notification markers when no opted-in device exists.
- [x] Move push tokens, alert filters, and notification wording to an anonymous installation identity so signing in, signing out, and account deletion do not control device notifications.
- [ ] Export any recoverable AWS development data after the suspended account is reactivated; do not block the source-backed development cutover on that export.

- [ ] Continuously discover and verify the broadest practical employer set, then prioritize active sources by technical early-career relevance and international/student-friendly coverage.
- [x] Define source-admission, attribution, removal, and source-quality policies.
- [x] Add internal source-aware filtering (FAANG, verified startups/YC, normal, U.S.-citizenship requirement, advanced-degree requirement, and open/closed status) to catalog ingestion, alerts, and mobile discovery.
- [x] Add the signed-in “new since last open” inbox with a calm first-open baseline, saved-filter matching, and count-led mobile launch screen.
- [x] Add signed-in swipe-left save for later, synced to the responsive web Saved queue and official-form handoff.
- [x] Add local swipe-right hide with Undo and Profile-based restore.
- [x] Add cursor-based endless scrolling through every role in the selected availability catalog.
- [x] Let notification recipients leave grouped new-match releases for the full catalog from either the release footer or the Roles tab.
- [x] Repair catalog index drift and add a guarded operator repair, daily full-table invariant audit, metric, and alarm for open, closed, and nontechnical jobs.
- [ ] Complete issue #99 catalog quality hardening and backfill.
  - [x] Add shared catalog normalization, structured locations/pay, defensive mobile presentation, and the guarded D1 repair workflow.
  - [x] Deploy the normalization and dry-run endpoint, then save the production dry-run report for owner approval.
  - [x] Apply the approved production repair with its exact token and changed-record count.
  - [x] Verify the post-repair audit, grouped projection, and unchanged job IDs/notification state through production D1 and API samples.
  - [ ] Verify representative iOS/Android rendering.
- [x] Separate catalog visibility from ingestion facts, keep provider baselines behind normal roles, and add the guarded 2026-08-09 Ashby recency repair.
- [x] Audit 25 representative employers through the GitHub Markdown ingestion and poller pipeline.
- [x] Add a provider-neutral company-coverage snapshot, public search API, and responsive web disclosure seeded from live internship evidence and reviewed ATS registries.
- [x] Implement the Greenhouse source adapter, admission gates, deterministic fixtures, and live contract tests.
- [x] Add the SQS-backed Greenhouse shadow/published runner with thirty-minute published polling, three-hour shadow polling, bounded per-board concurrency, isolated retries, alarms, and a quiet promotion baseline.
- [x] Publish the 166-board API-responsive Greenhouse inventory and admit 20 additional ownership-verified boards to production shadow monitoring, with current board identities, observed host allowlists, and per-source quiet baselines.
- [x] Add a private operations dashboard for all official Greenhouse sources with per-run volume, withheld rows, redacted diagnostics, queue/DLQ and alarm status, plus deterministic quarantine and recovery.
- [ ] Add the Greenhouse batch re-probe and post-publication ownership-review workflow described in [`greenhouse/registry-expansion-plan.md`](greenhouse/registry-expansion-plan.md).
- [x] Implement Lever source adapter, ETag checkpoints, technical-role mapping, and deterministic fixtures for Palantir, PlusAI, Hermeus, and Xsolla.
- [x] Add the SQS-backed Lever shadow/published runner with thirty-minute published polling, three-hour shadow polling, bounded per-board concurrency, isolated retries, alarms, and quiet promotion.
- [x] Standardize Greenhouse, Lever, general Markdown, and Quant Markdown behind neutral complete snapshots, shared processing, stable source occurrences, two-success closure reconciliation, deterministic outbox IDs, and durable source health.
- [x] Complete Lever monitoring with shadow and published health, regional metrics, freshness incidents, bounded backoff, shared operator controls, dashboards, and recovery runbooks.
- [x] Verify ETag behavior across representative Greenhouse and Lever boards, repair Greenhouse 304 classification, remove Lever's ineffective conditional path, and emit sanitized conditional-request metrics.
- [x] Add Ashby URL-derived discovery, metadata-only public probing, first-party ownership evidence, deterministic admission/re-verification gates, weekly candidate-ledger upload, and 35 reviewed shadow boards.
- [x] Implement the Ashby public posting adapter with listed-only complete snapshots, strict identity/schema/link gates, provider-neutral processing, deterministic fixtures, and a nightly live contract for every reviewed board.
- [x] Close the original Ashby emergency-promotion follow-up: all 35 original boards have refreshed first-party ownership evidence, normal 24-hour promotion evidence without overrides, and healthy production validation. The seven previously quarantined boards completed forced recovery on 2026-08-14 and resumed with empty work and dead-letter queues.
- [x] Admit and immediately publish Sentry as the 36th reviewed Ashby board on 2026-08-18 with explicit owner approval; its known internship was public but unlisted in the board API, so the direct monitor covers future listed roles while community sources retain the current occurrence.
- [x] Scan the live community catalog and deploy 109 newly ownership-verified sources to production shadow monitoring on 2026-08-18: 61 Ashby, 28 Lever, and 20 Greenhouse boards. The first batch admitted 44 sources through static evidence, and owner-reviewed browser verification admitted the remaining 65 exact ATS tenants.
- [ ] Complete Sentry's normal promotion observation follow-up after 2026-08-19T01:18:19Z and remove the temporary observation-window override.
- [x] Add Ashby application-assistance route detection and headed-browser workflows after runtime promotion; this remains separate from source ingestion. Published reviewed boards are eligible automatically.
- [x] Add human-readable source tags to default internship notifications for community job boards and published Greenhouse, Lever, and Ashby sources.
- [x] Add job freshness, verified employer-posted versus unverified source-reported versus InternNotifs-found timing across mobile, responsive web, and alerts, official/community provenance labels to role details and every catalog or saved-role card, filter-match explanations, hybrid New/New here status, and duplicate-safe notification deep links, including closed and unavailable states.
- [x] Add migration-safe structured internship/posting identity, conservative ATS alias reconciliation, grouped catalog/release APIs, permanent delivery-claim semantics, quiet-hours release modeling, and the reusable encrypted SNS/SQS notification construct.
- [ ] Activate the grouped notification construct with production batch workers, TestFlight-owner allowlisting, Firehose/Athena audit exports, and measured 15-second p95 delivery before disabling the legacy direct sender globally.
  - [x] Wire the production stream, aggregation, flush, personalized push/email, receipt, release-deep-link, and materialized catalog workers in infrastructure.
  - [ ] Execute the guarded identity/receipt migration, deploy to an owner-only cohort, export delivery audits, and measure the 15-second p95 gate.
- [x] Add user-facing settings with separate user-info, job-preference, and app/account destinations, including account deletion.
- [x] Add a user-facing data export surface.
- [x] Add source-quality reports, drift gates, nightly live probing, source-candidate review artifacts, and Firecrawl discovery-only workflow.
- [x] Define the shared headed/headless application-session state machine and trust boundaries.
- [x] Keep official-form opens in the persistent To Apply queue; mark Applied only after user confirmation.
- [x] Add the reviewed default-deny assistance policy, versioned session API, short-lived handoff credentials, and session metadata TTL.
- [x] Define and test Greenhouse and Lever high-confidence route detection plus the simple-field, review-only, and never-fill policy.
- [x] Build a local-only headed, no-submit browser companion pilot for reviewed Greenhouse and Lever test forms.
- [ ] Add the application review and verification-handoff experience.
- [ ] Prototype an isolated headless runner after the headed pilot establishes reliable field mappings.

### Product owner

- [ ] Reactivate AWS account `628031636041` long enough to export retained development data and approve the final Cloudflare cutover; do not delete retained resources during migration.

- [ ] Connect a GitHub account/repository with permission to create a GitHub Project and issues.
- [ ] Create a deploy-only AWS role or Identity Center permission set; stop using root credentials for deployment.
- [ ] Decide the default geographic emphasis for discovery ranking and the mobile experience; do not gate source verification on a hand-selected roster.
- [x] Approve the live privacy, terms, retention, and source/correction policies and confirm `onlinestuff309@gmail.com` as the public support mailbox on 2026-08-26.
- [ ] Enroll in Apple Developer Program and Google Play Console when beta builds are ready.
- [ ] Recruit 30–50 beta testers with iOS and Android devices.

## Metrics for closed beta

| Metric | Initial target |
| --- | --- |
| Source freshness | 95% of listed open roles checked within 90 minutes |
| Duplicate alert rate | Under 2% |
| Alert relevance | At least 70% of surveyed alerts rated relevant |
| Alert-to-detail open rate | At least 30% |
| Alert-to-application handoff | At least 10% |
| Notification retention | At least 60% of active testers still opted in after 14 days |

## Decisions log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-07-19 | Initial audience is international undergraduate/graduate students | Broader early-career reach; filters must support work authorization and location needs |
| 2026-07-19 | Initial roles are technical | Focus increases catalog quality and relevance |
| 2026-08-09 | Initial lifecycle scope includes internships, co-ops, apprenticeships, new-grad programs, and explicitly entry-level roles | Matches how employers label student and first-role hiring while excluding generic or merely junior titles |
| 2026-07-19 | Use official-form handoff, not universal direct submit | Better reliability and employer authorization boundary |
| 2026-07-20 | Explore headed assistance before headless preparation; require user review, verification, and final submit | Keeps the user in control while establishing reliable field mappings and challenge rates |
| 2026-07-29 | Track company coverage separately from any ATS provider and distinguish feed observations from reviewed direct sources | Makes broad discovery measurable without overstating community-list evidence as employer verification |
| 2026-07-19 | GitHub Project will be the shared external tracker | Fits open-source workflow and links work to code/issues |
| 2026-07-19 | Use FAANG, startup, and normal as the initial company-type filters | Small, understandable filters; startup begins with a reviewed YC-backed allowlist and unknown employers remain normal |
| 2026-08-25 | Operate as JD Krasnick under Pennsylvania law, require separate 18+ and policy signup attestations, and use the published private support email for personal-data requests | Provides a clear accountable operator and consent record without collecting date of birth |
| 2026-08-25 | Retain active account data until deletion, abandoned unverified signups for 7 days, inactive anonymous installations for 12 months, delivery records for 90 days, and assistance metadata for 30 days | Keeps product state available while bounding operational and abandoned data |
| 2026-08-25 | Publish code under MIT and InternNotifs-authored catalog metadata under CC BY 4.0, excluding employer text, trademarks, and third-party material | Supports an open-source project without relicensing material InternNotifs does not own |
| 2026-08-25 | Acknowledge source corrections within 2 business days, target resolution within 7 days, and promptly hide credible safety-sensitive listings during review | Makes the public correction path predictable while prioritizing user safety |
