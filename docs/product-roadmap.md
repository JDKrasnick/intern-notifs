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
| Official source adapters | Planned | Greenhouse and Lever ingestion has pagination, normalization, dedupe, freshness, and close handling |
| Catalog operations | Planned | Source health monitoring, stale-source alerts, and public source-request workflow work |
| Mobile discovery MVP | In progress | Filtered feed, native deep-link alerts, official-form handoff, and tracker are polished |
| Trust and release readiness | Planned | Settings/deletion UI, policy pages, store disclosure inputs, and release tests complete |
| Closed beta | Planned | 30–50 student test cohort and agreed success metrics |
| Public release | Planned | TestFlight/Play validation complete and catalog reliability meets target |

## Immediate backlog

### Codex

- [ ] Draft a first 100–200 employer roster with an explicit international/student-friendly coverage strategy.
- [ ] Define source-admission, attribution, and removal policies.
- [x] Add internal source-aware filtering (FAANG, verified startups/YC, normal, U.S.-citizenship requirement, advanced-degree requirement, and open/closed status) to catalog ingestion, alerts, and mobile discovery.
- [x] Audit 25 representative employers through the GitHub Markdown ingestion and poller pipeline.
- [ ] Implement Greenhouse source adapter and tests.
- [ ] Implement Lever source adapter and tests.
- [ ] Add job freshness/source labels and notification deep links to the mobile product.
- [ ] Add user-facing settings, account deletion, and data export surface.
- [ ] Add source-health metrics and operational runbook.

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
| 2026-07-19 | GitHub Project will be the shared external tracker | Fits open-source workflow and links work to code/issues |
| 2026-07-19 | Use FAANG, startup, and normal as the initial company-type filters | Small, understandable filters; startup begins with a reviewed YC-backed allowlist and unknown employers remain normal |
