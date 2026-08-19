# InternNotifs product tracker

## Product direction

**Promise:** a calm, mobile-first early-career radar that tells students about credible technical roles quickly and gets them to the official application form with minimal friction.

**Initial audience:** international and domestic undergraduate/graduate students.

**Initial scope:** technical internships, co-ops, apprenticeships, new-grad programs, and explicitly entry-level roles — software engineering, AI/ML, data, infrastructure/cloud, security, quantitative roles, product, and technical design.

**Product constraints:**

- Public browsing; account only for personal alerts, applications, and profile.
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
| Trust and release readiness | Planned | Settings/deletion UI, policy pages, store disclosure inputs, and release tests complete |
| Closed beta | Planned | 30–50 student test cohort and agreed success metrics |
| Public release | Planned | TestFlight/Play validation complete and catalog reliability meets target |

## Immediate backlog

### Codex

- [ ] Continuously discover and verify the broadest practical employer set, then prioritize active sources by technical early-career relevance and international/student-friendly coverage.
- [x] Define source-admission, attribution, removal, and source-quality policies.
- [x] Add internal source-aware filtering (FAANG, verified startups/YC, normal, U.S.-citizenship requirement, advanced-degree requirement, and open/closed status) to catalog ingestion, alerts, and mobile discovery.
- [x] Add the signed-in “new since last open” inbox with a calm first-open baseline, saved-filter matching, and count-led mobile launch screen.
- [x] Add signed-in swipe-left save for later, synced to the responsive web Saved queue and official-form handoff.
- [x] Add local swipe-right hide with Undo and Profile-based restore.
- [x] Add cursor-based endless scrolling through every role in the selected availability catalog.
- [x] Repair catalog index drift and add a guarded operator repair, daily full-table invariant audit, metric, and alarm for open, closed, and nontechnical jobs.
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
- [x] Add Ashby URL-derived discovery, metadata-only public probing, first-party ownership evidence, deterministic admission/re-verification gates, weekly candidate-ledger upload, and 35 reviewed shadow boards.
- [x] Implement the Ashby public posting adapter with listed-only complete snapshots, strict identity/schema/link gates, provider-neutral processing, deterministic fixtures, and a nightly live contract for every reviewed board.
- [x] Close the original Ashby emergency-promotion follow-up: all 35 original boards have refreshed first-party ownership evidence, normal 24-hour promotion evidence without overrides, and healthy production validation. The seven previously quarantined boards completed forced recovery on 2026-08-14 and resumed with empty work and dead-letter queues.
- [x] Admit and immediately publish Sentry as the 36th reviewed Ashby board on 2026-08-18 with explicit owner approval; its known internship was public but unlisted in the board API, so the direct monitor covers future listed roles while community sources retain the current occurrence.
- [x] Scan the live community catalog and deploy 109 newly ownership-verified sources to production shadow monitoring on 2026-08-18: 61 Ashby, 28 Lever, and 20 Greenhouse boards. The first batch admitted 44 sources through static evidence, and owner-reviewed browser verification admitted the remaining 65 exact ATS tenants.
- [ ] Complete Sentry's normal promotion observation follow-up after 2026-08-19T01:18:19Z and remove the temporary observation-window override.
- [x] Add Ashby application-assistance route detection and headed-browser workflows after runtime promotion; this remains separate from source ingestion. Published reviewed boards are eligible automatically.
- [x] Add human-readable source tags to default internship notifications for community job boards and published Greenhouse, Lever, and Ashby sources.
- [x] Add job freshness, trustworthy employer-posted versus InternNotifs-found timing across mobile, web, and alerts, official/community provenance labels, filter-match explanations, hybrid New/New here status, and duplicate-safe notification deep links to role details, including closed and unavailable states.
- [ ] Add user-facing settings, account deletion, and data export surface.
- [x] Add source-quality reports, drift gates, nightly live probing, source-candidate review artifacts, and Firecrawl discovery-only workflow.
- [x] Define the shared headed/headless application-session state machine and trust boundaries.
- [x] Keep official-form opens in the persistent To Apply queue; mark Applied only after user confirmation.
- [x] Add the reviewed default-deny assistance policy, versioned session API, short-lived handoff credentials, and session metadata TTL.
- [x] Define and test Greenhouse and Lever high-confidence route detection plus the simple-field, review-only, and never-fill policy.
- [x] Build a local-only headed, no-submit browser companion pilot for reviewed Greenhouse and Lever test forms.
- [ ] Add the application review and verification-handoff experience.
- [ ] Prototype an isolated headless runner after the headed pilot establishes reliable field mappings.

### Product owner

- [ ] Connect a GitHub account/repository with permission to create a GitHub Project and issues.
- [ ] Create a deploy-only AWS role or Identity Center permission set; stop using root credentials for deployment.
- [ ] Decide the default geographic emphasis for discovery ranking and the mobile experience; do not gate source verification on a hand-selected roster.
- [ ] Provide/approve privacy policy, terms, support email, and retention policy.
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
