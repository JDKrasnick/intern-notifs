# Plan: maximize supported employer metadata coverage

Status: expanded Worker and web deployed from PR #161, 2026-09-06. The owner authorized
implementation; production repair still requires its exact dry-run approval.

## Delivery status

The expanded PR includes five identity-checked public API acquisition paths
(Greenhouse, Lever, Ashby, Workday and SmartRecruiters), browser readiness and
exact-ID link recovery, native/unknown-period compensation, a shared API/mobile
formatter, field-level acquisition reporting, durable fair scheduling, host
backoff and a resumable read-only coverage CLI. Exact API evidence uses a separate
`official-api` slot so a board-list refresh cannot erase detail-only disclosures.

Migration `0017_metadata_acquisition.sql` is applied. The destination
consumer runs one batch at a time, five messages per batch. Historical API
collection avoids browser use when an exact-role response succeeds; normal
admission verification remains independent. Failed acquisition never supplies
new destination or employer authority.

Worker source `cdda7f6` is deployed with extraction v7. Live validation adds
paragraph/list boundary preservation, degree/job-level rates, encoded ranges,
dotted Ashby boards and exact Greenhouse embed recovery. The 53-posting replay
retains pay for every posting and removes its 52 reproduced conflicts; it is not
a full-cohort recall benchmark. Historical collection remains staging-only.

Remaining operational acceptance is explicit: finish independent browser/field
review and production collection (the existing credential now works), approve
and apply each exact repair batch, then verify public
coverage and unchanged IDs/notifications. API acquisition counts and parser
fixtures do not establish independently measured 95% disclosure recall. Oracle
uses the existing HTML/browser fallback; no undocumented Oracle API is enabled.

## Objective and boundaries

### September 6 accuracy sampling protocol

Freeze the public snapshot before inspecting employer evidence. The 21:38 UTC
frame contains 1,685 roles: 410 with pay text, 1,403 with metadata, and 21 with
housing. These are field-presence counts, not accuracy estimates.

- Draw 100 roles with a reproducible seed: 50 with pay and 50 without, stratified
  across Greenhouse, Lever, Ashby, Workday, ByteDance, and other destinations.
  Retain each stratum's population and sampling weight.
- Give readers only posting identity and official URLs, not the app's field
  values. Inspect complete exact-role API/page content, preserve all pay bands,
  eligibility conditions and short evidence quotes, and distinguish explicit
  currency/period from unknown. A blocked page or generic shell is unresolved,
  never evidence of nondisclosure.
- Independently check labels against saved artifacts before scoring; schema
  validation alone is insufficient. Record fetch time or artifact save time
  honestly. Separate housing benefits from generic relocation assistance.
- Review all 21 housing-positive roles as a targeted safety set. Do not pool
  this oversample into population estimates. Check amount, currency, cadence,
  employee cost versus employer support, and conditional eligibility.
- Reserve 30 additional blind roles (15 pay/15 blank) for holdout validation.
  Report verified denominators and unresolved cases alongside weighted pay
  precision/disclosure recall; do not claim complete coverage from attempted
  reads. Score education, locations/work mode, dates, and housing separately.
- Turn confirmed parser defects into regression fixtures, recollect using the
  new extraction version, and repeat public comparison after approved repairs.
  Collection completeness, conflicts, and exact repair approvals remain gates.

The frame, blind batches, original responses and independently checked labels
are archived under `.context/accuracy-20260906/`. Sampling and publication
acceptance remain in progress; no accuracy percentage is certified yet.

## Capture boundaries

Capture as much metadata as employers actually disclose on exact, official job
postings. Keep credible roles available when pay or another optional field is
absent. Measure acquisition success separately from extraction quality and
public display coverage.

- Do not invent pay, currency, period, work mode, education requirements or dates.
- Retain distinct location/education-specific compensation ranges and provenance.
- Match replacement destinations using authoritative posting identity; title
  similarity alone must never merge jobs or transfer salary.
- Metadata-only repair must not generate alerts, alter saved application IDs,
  or change publication/identity gates. Handle confirmed closed roles through
  the existing lifecycle workflow, separately from metadata repair.
- Use public, authorized employer sources. Do not bypass login, CAPTCHA or
  access controls, submit applications, or collect applicant information.
- Reuse the existing evidence/reconciliation model, browser queue and guarded
  collection/dry-run/apply workflow. Migrations 0015/0016 are already deployed.

## Baseline and evidence

Live public snapshot at 2026-09-05 19:20:44 UTC: 1,720 roles; 491 with any enriched
metadata; 269 with pay text; 262 with normalized USD pay; 36 employer publication
dates; 21 deadlines; 11 explicit work modes; six graduation windows. These are
availability figures, not extraction recall or complete-record counts.

Earlier HTTP audit: 1,453 missing-pay roles. Its pay-positive/review recheck found
111 recoverable disclosures. Browser spot checks covered 19 of the 275 unresolved
roles and verified seven disclosures, with three reproducible parser misses.
The other browser outcomes were four descriptions without pay found, four
missing/closed postings, three unresolved destinations, and one salary disclosure
with an unstated period. Do not extrapolate seven out of 19 to the full catalog.

Reference: [coverage audit](role-metadata-coverage.md). Local supporting artifacts:
`.context/reviews/coverage-audit/`, `.context/reviews/coverage-audit-v2/`, and
`.context/reviews/browser-pay-results-2026-09-05.md`. Preserve baseline IDs so
later gains can be deduplicated rather than adding counts from different snapshots.

## Phase 1 — recover proven misses and establish measurements

### 1A. Parser corrections and regression corpus

- [x] Add exact disclosure fixtures for all seven browser-confirmed roles.
- [x] Handle explicit hiring-range language (Daktronics), weekly/monthly/daily
  prefix labels (Tower), and currency between amount and period (Nokia).
- [x] Reconcile the legacy compensation normalizer with the evidence extractor
  so re-normalization cannot silently erase valid structured disclosures.
- [ ] Add negative fixtures for revenue, benefits, sign-on bonuses, application
  questions, mismatched posting IDs, conflicting currencies/periods, stale
  evidence, and multiple applicable ranges. Keep unrelated amounts separate.
- [x] Bump extraction version and verify re-extraction of unchanged artifacts
  after a version change, including existing and never-enriched records.

Primary areas: `src/role-metadata.ts`, `src/catalog-quality.ts`,
`src/ingestion/processor.ts`, metadata and catalog-quality tests.

Acceptance: all seven disclosures survive acquisition-fixture → extraction →
reconciliation → persistence → API projection with their stated amounts and
periods; all negative fixtures fail closed. No flattening of distinct ranges.

### 1B. Field-level audit accounting

- [x] Extend the existing audit with outcomes per field, provider and acquisition
  method: extracted, inspection-pending, acquisition-failed, incomplete-artifact,
  no-disclosure-found, ambiguous, conflicting, and projection-missing.
- [x] Separate artifact inspection from independently verified disclosure truth:
  “parser found nothing” must not become proof that the employer disclosed nothing.
- [x] Track source URL, posting ID, artifact hash, extraction version, observed
  time, truncation/completeness, retry state and bounded field excerpts.
- [x] Produce both a fixed-cohort comparison and the current live-catalog chart.
  Keep closed/removed roles visible in the cohort report so denominator changes
  cannot masquerade as metadata gains.

Acceptance: counts reconcile to their stated denominators; known browser findings
land in the correct buckets; acquisition failures cannot count as successful
inspections or extraction successes.

## Phase 2 — expand exact-role acquisition

### 2A. API-first metadata routing

- [x] Route known provider/tenant/posting IDs to public exact-role APIs even when
  the listing was originally discovered through GitHub or an employer wrapper.
- [x] Add Greenhouse detail enrichment with its documented `pay_transparency`
  and/or `pay_input_ranges` options; validate returned identity and ranges.
- [x] Verify Lever structured bands, salary descriptions and list sections, and
  Ashby's compensation-enabled response, through the full persistence pipeline.
- [x] Inventory Workday, Oracle and SmartRecruiters gaps. Add narrowly scoped
  adapters only for observed, public first-party contracts with verified IDs;
  retain HTML/browser fallback when no dependable contract exists.
- [x] Cache and coalesce identical exact-posting requests; validate size, content
  type, redirects and identity before accepting data. Respect rate limits.

Acceptance: fixtures cover each added API contract, malformed/partial responses,
non-USD pay and identity mismatches. A live read-only sample verifies each newly
supported provider without creating a new employer/source admission path.

### 2B. Browser completion and destination recovery

- [x] Wait for a role-specific description or a recognized terminal state, with
  a bounded timeout; distinguish a loading shell from a completed empty result.
- [x] Inspect embedded job frames and structured data; surface truncation and
  failed frames instead of classifying their missing text as non-disclosure.
- [ ] Recover moved destinations via reviewed canonical links, official APIs or
  exact posting IDs found in employer directories. Zipline 7978843003 is the
  initial regression case. Stage any canonical URL repair for existing guards.
- [x] Do not attach directory salaries, other-role recommendations or a similar
  title's data to the original role. Quarantine ambiguous replacement matches.
- [ ] Separate permanent missing/closed outcomes from transient maintenance,
  access restrictions and renderer failures. Send lifecycle evidence through
  the existing lifecycle rules rather than deleting roles in the metadata path.

Acceptance: tests cover migrated URLs, unrelated directory listings, iframe-only
descriptions, delayed rendering, maintenance, sign-in and closed pages. Exact
identity survives recovery; no login or CAPTCHA bypass occurs.

## Phase 3 — preserve and display every supported disclosure

- [x] Retain native currencies and hourly/daily/weekly/monthly/annual periods;
  distinguish unknown period from a stated nonstandard period. Use an additive,
  backward-compatible contract and distinguish unknown currency from USD.
- [x] Preserve explicit salary amounts with an unstated period as a disclosed
  amount, not a guessed annual salary. Keep that category separate in reports.
- [x] Make plausibility validation currency/period-aware; USD-specific bounds
  must not silently discard credible foreign-currency disclosures.
- [ ] Ensure public APIs and mobile detail, cards, grouped results and Saved
  render the same supported ranges, applicability and currency. Missing optional
  metadata remains calm and does not block the employer application action.
- [x] Keep legacy normalized USD fields for compatible consumers only when
  justified. Do not use unknown-period or incomparable ranges in pay sorting.
- [ ] Apply the same exact-source extraction and audit approach to education,
  graduation windows, locations, work mode, deadlines and employer dates.
  First-seen time is not employer publication time; location is not work mode;
  ambiguous dates/timezones remain unresolved.

Acceptance: API/mobile contract tests cover non-USD, weekly pay, unknown period,
multiple locations, missing fields, conflicts and old clients. All affected
surfaces show consistent amounts without unsupported conversion or inference.

## Phase 4 — sustainable enrichment and full validation

- [x] Add cursor-based, resumable scheduling with fair progress across sources;
  do not repeatedly select only the first fixed-size batch of roles.
- [ ] Prioritize never-inspected roles, known parser misses, version upgrades,
  changed artifacts and stale evidence. Do not require current-version projected
  evidence before a role can receive its first or upgraded extraction.
- [x] Use per-host concurrency, bounded retries/backoff, negative-result expiry,
  request deduplication and configurable browser budgets. Avoid retry storms and
  repeated browser work for unchanged, fully inspected artifacts.
- [ ] Finish the remaining 256 browser-audit roles and review the earlier 445
  pay-language candidates, deduplicating against current IDs and source updates.
- [ ] Sample the 535 “no pay detected” artifacts for false negatives; expand the
  audit wherever a provider pattern fails. Audit other metadata fields too.
- [ ] Publish request/error counts, latency, browser usage and outcome deltas
  alongside coverage so operational cost and regressions remain visible.

Acceptance: repeated runs converge without starvation; a simulated interruption
resumes safely; no duplicate observations or notifications result. Each reviewed
supported disclosure is either projected or has a specific, visible blocker.

## Rollout sequence and gates

1. Complete Phase 1 fixes/tests. In parallel, locate the existing operations
   credential through its approved store; never put it in Git or chat. Credential
   availability blocks authenticated backfill, not development or public audits.
2. Run existing collection in resumable batches; archive its completion and
   conflicts, then stage a dry-run pinned to the exact evidence/version.
3. Obtain owner approval of the dry-run's exact token and changed job/occurrence
   counts. Apply through existing guards; if evidence or counts change, restage.
4. Verify projected metadata, public API samples, Saved/grouped consistency,
   unchanged IDs and notification/outbox state, and zero projection-only omissions.
5. Roll out Phases 2–4 in provider-sized canaries, repeating collection and guarded
   repair as needed. Preserve current production publication/identity settings.
6. Record rollback checkpoints. Disable a faulty acquisition path without
   discarding provenance; restore projections through reviewed repair rather
   than broad database rewrites. Update deployment docs and roadmap as work lands.

Required checks per code slice: focused regressions, full repository tests,
typecheck, lint and Worker build. Run mobile checks for contract/presentation
changes and inspect live provider samples for acquisition changes. Tests must
cover both cold ingestion and historical replay, evidence withdrawal/conflicts,
queue retries, interrupted collection and concurrent updates.

## Completion criteria

- All confirmed supported misses in the maintained audit corpus are fixed or
  explicitly blocked by access/identity; no silent extraction or projection gap.
- Every audit-cohort role has a dated acquisition outcome; failures and missing
  disclosures remain distinct, and no unknown is silently counted as complete.
- No false-positive pay, cross-role evidence transfer, fabricated currency/period,
  or unintended notification in regression tests and the reviewed live sample.
- Field-level disclosure recall is measurable on an independently reviewed,
  provider-stratified benchmark. Target at least 95% of explicit disclosures in
  successfully acquired exact-role artifacts; report sample size, exclusions and
  failures. This is a quality target, not a promise of pay on 95% of catalog roles.
- Public coverage gains are verified after guarded repair; the earlier roughly
  22% pay estimate is not treated as an achieved result or a ceiling.

## Suggested delivery slices

1. Confirmed parser regressions and version-upgrade scheduling tests.
2. Field-level audit accounting and resumable collection.
3. Exact-role API enrichment, one provider contract at a time.
4. Browser completion and identity-safe destination recovery.
5. Broader compensation representation plus compatible API/mobile display.
6. Scheduling, full-cohort validation and final production backfill evidence.

The owner requested the complete implementation in PR #161, with a split only
if needed. Keep these coupled acquisition/replay/display contracts in that PR.
Do not mark issue #134's production rollout complete solely because CI is green.
