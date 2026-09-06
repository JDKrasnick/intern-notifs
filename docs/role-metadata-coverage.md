# Employer metadata coverage audit — 2026-09-05

## Scope and result

The public catalog contained 1,720 roles, including 267 with normalized USD pay
(15.5%). All 1,453 roles without pay were inspected using bounded employer-page
HTTP acquisition and the same exact-posting gate, JSON-LD extraction and metadata
projection used by the application. This is field coverage, not test coverage.

| Initial inspection outcome | Roles |
| --- | ---: |
| Supported pay recoverable by the original extractor | 54 |
| Pay language requiring review | 505 |
| No pay detected in the inspected artifact | 535 |
| Unresolved destination | 275 |
| Aggregate board rather than an exact role | 84 |

Extraction version 2 fixes decimal/comma amounts, annualized pay, hourly/annual
prefix labels, `/per year`, and ordinary connecting words misread as currencies.
Reinspection of the 559 pay-positive/review candidates found 111 with supported
pay, 445 still needing review and three whose destinations became aggregate
boards. That is 57 more recoverable roles than the initial pass. If all 111 pass
the guarded backfill, the unchanged catalog would reach 378/1,720 (22.0%). This
is a recoverability estimate, **not achieved production coverage**.

The audit does not establish recall against all employer disclosures. In
particular, absence from a bounded artifact does not prove absence from the
employer page. Some ranges omit a period or currency, some text concerns benefits
or company revenue, and some destinations need browser inspection. No missing
pay is invented, and no missing-pay role is removed for that reason.

## Acquisition and regression protection

Six minimal live-disclosure fixtures cover Workday, Greenhouse and custom pages.
Lever acquisition preserves structured salary bands, separate salary descriptions,
list sections and all locations. Supported intervals map directly to their stated
period; missing, invalid or unsupported intervals are not assumed annual. The
[public Lever contract](https://github.com/lever/postings-api) documents these
fields; the [Lever reference](https://hire.lever.co/developer/documentation)
defines the salary interval values. Ashby already requests compensation with its
public posting response. Broader provider coverage still needs direct validation.

The first Chrome attempt was interrupted. A subsequent native Chrome pass
inspected 19 unresolved roles: seven disclosed pay, four descriptions had no pay
found, four postings were missing/closed, three remained unresolved, and JPMorgan
disclosed salary amounts without stating a period. Regression clauses cover
Zipline, StepStone, Citadel Securities, Daktronics, Tower Research, Nokia and
Cotiviti. These spot checks do not establish recall for the full unresolved cohort.

Local evidence is archived under `.context/reviews/coverage-audit/` and
`.context/reviews/coverage-audit-v2/` (gitignored): catalog snapshots, per-role
outcomes, bounded pay excerpts, extracted evidence and summaries. Initial audit
completed at 18:22:29 UTC; reinspection completed at 18:27:31 UTC.

## Rollout status

Migrations 0015 and 0016 were applied to production, and PR #161 was deployed
with main's PR #160 recovery and PR #159 trusted-source changes retained. Deployment
preserves the existing unconfirmed-publication setting and 70% identity floor.
The public jobs endpoint returned HTTP 200 after deployment.

Post-deployment at 18:37:32 UTC, the catalog still contained 1,720 roles: 267
retained pay text, 262 had normalized USD values, and 93 had role metadata from
normal processing. Five legacy Skydio/Notion records retained their separate pay
amounts but no longer had one flattened USD minimum/maximum: the existing
normalizer deliberately does not combine multiple distinct candidates. The
22.0% estimate above describes possible pay-text coverage, not one comparable
USD range for every role. Deployed code revision: `1f28d5c`; Worker version:
`e241f4bd-b058-4000-a21a-6c5c3c5f60c6`.

Historical collection, guarded dry-run/apply and post-apply verification remain
pending: the existing operations credential is unavailable in this workspace.
Do not replace the credential or bypass the exact token/count guards. The
zero-supported-misses objective is not yet established. Next priorities are the
445 pay-language cases and inaccessible/browser-only destinations, followed by
field-by-field validation of education, work mode, locations and dates.

## Expanded implementation and live API pass

PR #161 now includes extraction version 4 and exact-role API acquisition for
Greenhouse, Lever, Ashby, Workday and SmartRecruiters. Greenhouse requests its
[documented transparency fields](https://docs.greenhouse.io/job-board.html#retrieve-a-job);
SmartRecruiters uses its [public posting-detail endpoint](https://developers.smartrecruiters.com/docs/endpoints#postingspostingid).
Workday's public CXS response was checked against both requisition IDs and complete
presentation slugs, including Salesforce's `JR340771-1`; suffixes are not stripped
or merged. Oracle remains on the existing HTML/browser fallback.

The read-only pass completed at **2026-09-06 00:54:53 UTC** (September 5 locally).
It scanned API routes for 1,091 roles from a public snapshot of 1,723 roles.

| API acquisition path | Roles attempted | Exact response acquired | Pay extracted |
| --- | ---: | ---: | ---: |
| Greenhouse | 417 | 409 | 176 |
| Lever | 91 | 90 | 65 |
| Ashby | 149 | 106 | 51 |
| Workday | 388 | 375 | 90 |
| SmartRecruiters | 46 | 46 | 6 |
| Total | 1,091 | 1,026 | 388 |

Of the 388 pay-positive artifacts, 305 correspond to roles without pay in the
original 1,720-role baseline. These are **extraction candidates**, not 305 deployed
fills or an independently reviewed recall measurement. They include native
currencies, explicitly nonstandard intervals, and amounts with an unknown period.
They must pass reconciliation, conflict review and guarded projection repair.

The 65 unsuccessful API acquisitions remain visible: 22 Ashby boards exceeded
the bounded response budget, 18 Ashby responses lacked the requested exact posting,
and 25 requests failed (13 Workday, eight Greenhouse, three Ashby and one Lever).
Browser fallback remains available; none is classified as employer non-disclosure.

The public snapshot had 271 roles with pay (15.7%), 591 with role metadata (34.3%),
137 employer publication dates, 21 deadlines, 25 explicit work modes and 29
graduation windows. The original fixed cohort retains all 1,720 IDs: 267 retained
pay, four gained pay, 1,448 still lack pay and one left the public catalog. These
background-production changes occurred before deploying this expansion.

Reproduce or resume the public audit without operations credentials:

```bash
npm run audit:metadata-coverage -- --baseline PATH_TO_BASELINE_JSON \
  --api-limit 2000 --report .context/metadata-coverage.json
# Revisit failures while retaining completed records:
npm run audit:metadata-coverage -- --api-limit 2000 --retry-failed \
  --report .context/metadata-coverage.json
```

The saved report records per-role methods, versions, hashes, timestamps, failures,
field outcomes and compensation evidence. `--retry` revisits every recorded role;
`--catalog PATH` uses a pinned catalog instead of fetching a new public snapshot.
The local validated report is
`.context/reviews/metadata-api-validated-2026-09-05.json` (gitignored).

Before deployment, apply `0017_metadata_acquisition.sql`. Automated collection
reserves disjoint batches, interleaves hosts, revisits never-inspected/old-version
roles, expires abandoned reservations after 30 minutes and honors API host backoff.
The consumer has concurrency one and batches of five. Manual collection returns
an opaque `nextCursor`; pass it through `--cursor` with the same collection token.
An exhausted cursor is not proof that queued work completed; check the audit and
restart from the beginning after outstanding reservations expire if needed.

`supportedRoleSpecificDisclosedMetadataMisses` and `disclosureRecall` return null
until an independently reviewed benchmark exists. `projectionOnlyOmissions`
remains the separate deterministic projection-diff metric. Per-field outcomes
distinguish extracted, pending inspection, failure, incomplete artifacts,
ambiguity, conflict and projection omission; only independent review can declare
`no-disclosure-found`.

The expansion has **not** been deployed or applied to historical production
records. The operations credential and exact repair approval remain required.
Independent review of the remaining browser/pay-language cohort remains open in
[the delivery plan](metadata-coverage-plan.md).

Local validation: 1,274 backend tests and 90 mobile tests passed, alongside root
and mobile type checks, lint, TypeScript build, Worker dry-run build, mobile web
export and OpenTofu formatting/validation. The iOS Simulator build launches;
native pay-detail acceptance remains open because the test deep link showed a
role-unavailable state despite the public detail endpoint returning HTTP 200.
No native screenshot is counted as successful pay-display verification.
