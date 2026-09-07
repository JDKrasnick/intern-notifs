# Employer metadata coverage audit — 2026-09-05

## Latest implementation: extraction v14 — 2026-09-07

Worker source `31f278f`, version `155ddb09-e5c6-4d5e-aa27-814cba5e0498`,
is deployed with source-processing revision 2 and production flags preserved.
All 1,430 backend tests and 101 mobile tests pass; type checks, lint, Worker
compilation and PR CI pass. The separate production web deployment remains on
Cloudflare Pages and is not overwritten by this backend rollout.

Full official-response replays retain Magna's six school-year/degree pay rows
and PayPal's three location bands. Unknown currency and Magna's unstated pay
period remain unknown. The Greenhouse source path retains Databricks' regional
bands. Durable legacy 404/410 decisions no longer poison bounded source refresh;
timeouts, blocked requests and persistence failures remain retryable/pending.

At 21:59 UTC, the public catalog still contains 1,643 roles, 418 with pay text,
1,641 with metadata and 22 with housing. The frozen sample still has known
missing disclosures. Fresh v14 collection starts at 97/4,788 current pairs,
not the v13 result of 4,673/4,786. No historical repair is approved or applied.
Source freshness, complete evidence, unresolved conflict reviews, exact repair
approval and public rescoring remain required; see the [current validation
checkpoint](metadata-coverage-plan.md#september-7-validation-checkpoint).

## Earlier implementation: extraction v10 — 2026-09-06

Worker source `eee0205`, version `cb3feb19-bc79-4110-94b0-5a416896aba4`,
is deployed with publication flags independently verified unchanged. Web source
`9e55df6`, deployment `6af88108.internnotifs.pages.dev`, serves the canonical site.
At 20:45 UTC, 1,685 public roles include 409 with pay (24.3%), 1,379 with enriched
metadata (81.8%), and 21 with housing information (1.2%). These are field-presence
counts, not disclosure recall, numeric housing-cost coverage, or proof of repair.

Live QA found seven Varda roles with a $20 cell-phone reimbursement in the salary
display. V10 binds reimbursement exclusions to the individual monetary clause.
All seven exact employer payloads now replay through ordinary ingestion with
one USD 33/hour wage, the relocation-conditional housing stipend, and zero
conflicts. The original 53-posting corpus still retains pay throughout with zero
reproduced conflicts; all 19 SpaceX source-path cases retain pay too.
The 20:45 public snapshot confirms all nine current Varda roles exclude the
reimbursement: eight show USD 33/hour, Flight Software shows USD 37/hour, and
all nine retain conditional housing separately after the ordinary 20:43 refresh.

The new extraction version requires fresh evidence. Its initial audit starts at
0/4,645 current source/posting pairs, with 3,434 deferred projections. V9's 95.6%
collection coverage is not v10 validation. Existing public projections remain
accepted-but-stale until their sources refresh; historical collection only
stages evidence. No historical repair is approved or applied. Version-bound
omission reviews must be regenerated before any historical publication.
Exact-cohort comparison confirms all 45 prior pay-loss roles display pay again
at 20:45, up from 43 at 20:24. Recovery of field presence does not prove accuracy:
two TikTok roles display community $60/hour while rendered official-page browser
evidence gives $42.75/hour and $45–60/hour respectively. Jump displays community
USD 138/hour alongside official 250,000/year with unstated currency. Cross-unit
and unknown-currency ranges occupy separate reconciliation groups, so this
source-authority case needs further validation before rollout acceptance.

Web QA also fixes invisible guest catalog controls in the keyboard order,
missing radio/filter states, and a clipped company-coverage toggle. Direct ARIA
props work in both installed renderers; a regression test checks the real web
renderer and actual JSX wiring. Browser confirmation passes at 1440, 390 and
320px, including Profile, Saved, and the sign-in overlay. The native appearance
and inactive-list behavior remain unchanged; physical-device acceptance is open.

Validation: 1,362 backend tests pass (284 skipped), 100 mobile tests pass, both
type checks and lint pass, and Worker compilation/web export succeed. The code
commits' CI checks pass. No account or notification data changed in these checks.

## Previous implementation: extraction v9 — 2026-09-06

Worker source `fba716c`, version `1f9364cf-1f09-499e-be5f-8db386b68767`,
serves 100% of production traffic as of 19:27 UTC. Migrations 0018–0019 are
applied; production publication flags remain unchanged. Web deployment
`e52e8436.internnotifs.pages.dev` serves `internnotifs.app` with separate housing
rows and corrected icon assets. At 19:27 UTC the public catalog has 1,685 roles:
247 with pay (14.7%), 1,164 with enriched metadata (69.1%), and zero with published
housing. Staged evidence is not an applied coverage gain.

The earlier pay count fell from 270 to 224 during ordinary refreshes. Comparing
the September 5 snapshot with the 19:06 catalog confirms 45 still-live roles lost
pay while retaining version-7 SpeedyApply evidence. A current-version refresh
from another source filtered that evidence out and treated the absent projection
as withdrawal. Accepted projections now wait for their contributing snapshots
to be re-extracted or removed; stale evidence is not promoted into a new result.
Those 45 roles remain blank at 19:25; the later rise to 247 is not their recovery.

Source checkpoints separately record the extraction version and preprocessing
revision. A parser upgrade requires one successful full source reconciliation
before conditional ETags/hashes resume. Failed refreshes, HTTP 304s and admission
migration slices cannot mark the replay complete. `deferredProjections` exposes
accepted fields waiting for source refresh and blocks historical apply, even if
destination collection alone is complete.

Ordinary ingestion now preserves paragraph/list boundaries for metadata while
retaining existing admission/lifecycle classification text. All 19 SpaceX
postings from the latest conflict sample retain pay and produce zero conflicts
when replayed through source preprocessing revision 1. This fixes the source
path's flattened pay tiers without restarting version-9 API collection.
Historical browser collection can acquire a newly observed exact Greenhouse
embed through the existing fixed-host API checks, and collision detection cannot
write another job's admission. Tower's live retry remains behind its existing
September 7 backoff; the route is regression-tested, not yet production-rechecked.

V8 adds separately provenanced housing stipends, employer-paid housing, intern-paid
housing costs and availability with unconfirmed cost. Amounts retain their stated
currency and period; conditional or combined benefit amounts remain in the
bounded employer wording when they cannot be isolated safely. Housing never
becomes base salary. Interview/disability accommodations are excluded. The role
detail UI displays housing independently, including conditions and the excerpt.

The v8 production canary exposed adjacent Ashby hourly bands followed by
“Eligible for housing stipend”. V9 separates bullet/pipe-delimited benefits,
leaving stipend eligibility without mislabeling the salary as a housing amount.
It also avoids equating generic housing support with available accommodation and
keeps qualification/relocation conditions explicit. Housing amounts combined
with travel, relocation or other compensation remain unquantified.
Production v9 canaries confirm both the RV Tech correction and Melius's separately
stated USD 2,500/month housing stipend. Omission preview succeeds with zero public
writes. The owner approved both Melius omission decisions at 18:39 UTC, changing
zero public jobs. Later evidence invalidated the Spring/Summer 2027 decision's
fingerprint; its renewed preview awaits approval. No historical repair is approved
or applied.

Validation: 1,351 backend tests pass (284 skipped); root type checks, lint and the
Worker build pass. Earlier unchanged-client validation has 94 mobile tests,
mobile type checks and production web export passing. Focused synthetic housing review passes on iPhone, XXL Dynamic Type
and iPad; Android, hardware, VoiceOver and native live-pay acceptance remain open.

General correctness fixes keep graduate audiences separate from graduation dates,
preserve degree alternatives and waived requirements, reject impossible calendar
dates, retain explicit deadline timezones, and distinguish technical titles such
as “Remote Sensing” from actual remote-work qualifiers.

Additional pay regressions cover regional exceptions, structured Greenhouse band
units, spaced thousands/currency codes, adjacent minimum/maximum fields, Workday
start/end labels and explicit lower-bound starting rates. The original 53-posting
API replay still retains pay on every posting with zero reproduced conflicts.
In the final 44-response API sample, only two Melius postings retain conflicts:
the API declares USD 11,000/month while the description separately declares
8,500 salary and 2,500 housing stipend. No salary winner is inferred.

An operations-only reviewed-omission workflow requires an exact approved review
token, then a separately approved repair token/counts. Review approval changes no
public job. Activated omissions expire when versioned evidence changes. Migration
0018 adds the ledger and an atomic revision guard. Migration 0019 scopes review
approval to the posting's revision without weakening the catalog-wide repair
guard; unrelated conflicts and the full collection gate remain blocking. See
[deployment instructions](DEPLOYMENT.md#reviewed-omission-of-disputed-pay).

These are implementation and sample-validation results, not achieved historical
coverage or catalog-wide disclosure recall. The v7 collection pass reached
4,430/4,670 current source-posting pairs with 240 unresolved at its last audit;
cursor exhaustion is not completion. V9 collection reaches 4,458/4,666 current
source-posting pairs (95.5%) at 19:27 UTC, with 208 pending and zero stale. The
same audit has 944 deferred projections and 26 open conflict records. An earlier
19:22 repair preview remains blocked, with 20 recomputed conflicts; 19 are the
SpaceX source-path issue addressed above and one is the renewed Melius review.
Historical repair remains unapplied pending complete evidence and exact approval.

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

At that deployment, historical collection, guarded dry-run/apply and post-apply
verification remained pending because the operations credential was unavailable.
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

At the read-only API pass, the expansion had **not** been deployed or applied to
historical production records. See the September 6 rollout update below.
Independent review of the remaining browser/pay-language cohort remains open in
[the delivery plan](metadata-coverage-plan.md).

Local validation: 1,274 backend tests and 90 mobile tests passed, alongside root
and mobile type checks, lint, TypeScript build, Worker dry-run build, mobile web
export and OpenTofu formatting/validation. The iOS Simulator build launches;
native pay-detail acceptance remains open because the test deep link showed a
role-unavailable state despite the public detail endpoint returning HTTP 200.
No native screenshot is counted as successful pay-display verification.

## Production rollout — 2026-09-06

The existing operations credential now authenticates successfully; it was not
rotated. Migration `0017_metadata_acquisition.sql` is applied. Worker version
`de22f8fe-5dbf-48cf-823a-35000a3201e0` serves revision `cdda7f6` at 100%
(16:56:51 UTC), with extraction version 7.
The previous dashboard versions had the same script hash as the deployed GitHub
timeout fix `7fc3073`; that fix is merged and retained. Publication remains
enabled with the 70% confirmed-identity floor; trusted-community publication
remains disabled. GitHub full-cycle freshness is still not validated.

Web deployment `39baac25` serves the shared pay formatter at `internnotifs.app`.
An actual browser check confirmed Salesforce's USD 54/hour on both the card and
role detail, with the official-application action available. No native release
or successful native pay-detail acceptance is claimed.

Production canary testing exposed a Worker runtime incompatibility with Fetch
`redirect: 'error'`: API calls failed before reaching employers, despite passing
in Node. Acquisition now uses `manual` and rejects redirects without following
them; a local Worker probe verifies an exact Greenhouse response. Extraction
version 5 revisits the affected browser-only records. Collection and audit now
share eligibility, including open withheld jobs and legacy occurrences whose
confirmed immutable posting key exactly matches their official URL. Neither
change grants new employer authority or alters admission decisions.

The version-5 collection denominator is 4,647 job/source pairs, up from 2,621;
this is not the 1,723-role public catalog denominator. Historical collection is
staging-only. The first production dry run exceeded the 900-record atomic limit;
dry runs now stage at most 900 jobs and report `remainingJobs`, while retaining
global collection, evidence and conflict guards. Every batch needs independent
owner approval of its exact token/counts. No historical repair has been applied.

Public snapshot at 06:25:54 UTC: 1,723 roles, 273 with pay (15.8%), 647 with some
enriched metadata (37.6%), 139 employer publication dates, 21 deadlines, 28
explicit work modes and 29 graduation windows. These include normal ingestion
changes, not historical repair gains or measured disclosure recall.

Version 5's 110 queued pairs produced 41 successful Workday API reports, 21
Greenhouse, five Lever and five SmartRecruiters. Browser reports comprised 32
complete and six incomplete acquisitions. The audit retained 105 current pairs
(one had earlier complete evidence), not 110 successful acquisitions. Aggregate
destinations and truncated/unfinished pages remain unresolved.

Browser inspection of Cohere's exact posting found that its three geographic
salary bands lost their labels when body text was flattened, and `CA$` amounts
were split. Extraction version 6 preserves visible list rows immediately under
explicit compensation headings, recognizes qualified dollar symbols, and keeps
unstated periods unknown. The live DOM supplied a regression that clears the
false conflict through guarded database repair in tests. The same page requires
five years' experience; its eligibility needs separate source-quality review,
not an admission change through metadata backfill.

The version-6 production canary completed all ten pairs. A read-only D1 check
confirmed all three labeled Cohere bands for both source references, including
CAD 140,000–175,000 with unknown period. Its acquisition reports changed from
`conflicting` to `ambiguous` (unstated periods/currencies remain unknown), without
applying a public repair. Collection continues in bounded batches; the 4,647-pair
cohort is not yet complete.

Validation for `13a89ec`: 1,286 backend tests passed, 284 skipped; type checks,
lint, Worker dry-run build and all PR checks passed. Regressions cover the Worker
redirect mode, confirmed legacy identity, version-aware retry backoff, and
901-job repairs with a conflict outside the selected atomic batch. Local rollout
reports are under `.context/reviews/metadata-rollout-2026-09-06/` (gitignored).

### Afternoon validation

Version 7 preserves paragraph/list boundaries in API, JSON-LD and rendered
descriptions; decodes encoded range dashes; and keeps degree/job-level rates
separate. A 53-posting live API corpus reproduced 52 conflicts with the old
parser and zero with the new parser, with pay retained for every posting.
Production evidence confirms J&J's USD 23.50–52.50/hour, Freeform's three
degree-specific hourly rates, and Univera's two labeled ranges with unstated
period/currency. These checks do not establish catalog-wide disclosure recall.

Exact acquisition also supports dotted Ashby board names and observed Greenhouse
embed identities. Live API checks recover Persona's education requirements and
Tower Research's 3,500–5,700/week disclosure (currency not stated). A local browser
confirms Citadel's 4,500–5,800/week disclosure, but production browser acquisition
still fails there. Failed/partial acquisitions retain their retry backoff and
remain unresolved; no guard is relaxed to complete the repair.

At 16:58:37 UTC the public catalog contains 1,682 roles: 270 with pay (16.1%) and
1,007 with enriched metadata (59.9%). The changing public cohort includes normal
ingestion/lifecycle updates, not historical repair gains. Version-7 collection
has restarted across 4,657 eligible job/source pairs and remains incomplete.
The D1 repair-guard table still records zero applied repairs.

Validation for `cdda7f6`: 1,295 backend tests passed, 284 skipped; typecheck, lint,
Worker dry-run build and all PR checks passed. Native acceptance and the
independent disclosure benchmark remain open.
