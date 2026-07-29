# InternNotifs product tracker

## Product direction

**Promise:** a calm, mobile-first internship radar that tells students about credible technical roles quickly and gets them to the official application form with minimal friction.

**Initial audience:** international and domestic undergraduate/graduate students.

**Initial scope:** technical internships only — software engineering, AI/ML, data, infrastructure/cloud, security, quantitative roles, product, and technical design.

**Product constraints:**

- Public browsing; account only for personal alerts, applications, and profile.
- Prefer official employer career sources and openly maintained, attributed public lists.
- Never automate a non-partner submission; users review and submit official forms themselves.
- Core experience remains free, simple, privacy-respecting, and suitable for open-source development.

## Milestones

| Milestone | Status | Exit criteria |
| --- | --- | --- |
| Catalog definition | In progress | Initial employer roster, source rules, taxonomy, and reliability targets approved |
| Official source adapters | In progress | Lever ingestion is live for reviewed boards; Greenhouse, Ashby, and SmartRecruiters remain planned |
| Catalog operations | In progress | Shared source-quality gates, live reports, roster review queue, and bounded Firecrawl research workflow operate |
| Mobile discovery MVP | In progress | Filtered feed, native deep-link alerts, official-form handoff, and tracker are polished |
| Human-reviewed application assistance | In progress | Headed pilot fills a supported official form, pauses for unknowns and verification, and leaves final submission to the user |
| Headless application preparation | Planned | Isolated runner reuses proven mappings, supports live user handoff, and never bypasses verification or non-partner submission controls |
| Trust and release readiness | Planned | Settings/deletion UI, policy pages, store disclosure inputs, and release tests complete |
| Closed beta | Planned | 30–50 student test cohort and agreed success metrics |
| Public release | Planned | TestFlight/Play validation complete and catalog reliability meets target |

## Immediate backlog

### Codex

- [ ] Draft a first 100–200 employer roster with an explicit international/student-friendly coverage strategy.
- [x] Define source-admission, attribution, removal, and source-quality policies.
- [x] Add internal source-aware filtering (FAANG, verified startups/YC, normal, U.S.-citizenship requirement, advanced-degree requirement, and open/closed status) to catalog ingestion, alerts, and mobile discovery.
- [x] Add the signed-in “new since last open” inbox with a calm first-open baseline, saved-filter matching, and count-led mobile launch screen.
- [x] Add signed-in swipe-left save for later, synced to the responsive web Saved queue and official-form handoff.
- [x] Add local swipe-right hide with Undo and Profile-based restore.
- [x] Audit 25 representative employers through the GitHub Markdown ingestion and poller pipeline.
- [ ] Implement Greenhouse source adapter and tests.
- [x] Implement Lever source adapter, ETag checkpoints, technical-role mapping, and deterministic fixtures for Palantir, PlusAI, Hermeus, and Xsolla.
- [ ] Add job freshness/source labels and notification deep links to the mobile product.
- [ ] Add user-facing settings, account deletion, and data export surface.
- [x] Add source-quality reports, drift gates, nightly live probing, roster review artifacts, and Firecrawl discovery-only workflow.
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
- [ ] Decide the initial geographic emphasis and approve the first employer roster.
- [ ] Provide/approve privacy policy, terms, support email, and retention policy.
- [ ] Enroll in Apple Developer Program and Google Play Console when beta builds are ready.
- [ ] Recruit 30–50 beta testers with iOS and Android devices.

## Metrics for closed beta

| Metric | Initial target |
| --- | --- |
| Source freshness | 95% of listed open roles checked within 30 minutes |
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
| 2026-07-19 | Use official-form handoff, not universal direct submit | Better reliability and employer authorization boundary |
| 2026-07-20 | Explore headed assistance before headless preparation; require user review, verification, and final submit | Keeps the user in control while establishing reliable field mappings and challenge rates |
| 2026-07-19 | GitHub Project will be the shared external tracker | Fits open-source workflow and links work to code/issues |
| 2026-07-19 | Use FAANG, startup, and normal as the initial company-type filters | Small, understandable filters; startup begins with a reviewed YC-backed allowlist and unknown employers remain normal |
