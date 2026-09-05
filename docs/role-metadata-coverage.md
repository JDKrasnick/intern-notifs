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

Chrome navigation was interrupted by a window change and an isolated browser was
unavailable. Employer-page UI inspection therefore remains unverified; successful
HTTP inspection is not presented as browser validation.

Local evidence is archived under `.context/reviews/coverage-audit/` and
`.context/reviews/coverage-audit-v2/` (gitignored): catalog snapshots, per-role
outcomes, bounded pay excerpts, extracted evidence and summaries. Initial audit
completed at 18:22:29 UTC; reinspection completed at 18:27:31 UTC.

## Rollout status

Migrations 0015 and 0016 were applied to production, and PR #161 was deployed
with main's PR #160 recovery and PR #159 trusted-source changes retained. Deployment
preserves the existing unconfirmed-publication setting and 70% identity floor.
The public jobs endpoint returned HTTP 200 after deployment.

Historical collection, guarded dry-run/apply and post-apply verification remain
pending: the existing operations credential is unavailable in this workspace.
Do not replace the credential or bypass the exact token/count guards. The
zero-supported-misses objective is not yet established. Next priorities are the
445 pay-language cases and inaccessible/browser-only destinations, followed by
field-by-field validation of education, work mode, locations and dates.
