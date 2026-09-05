# Provider-neutral destination audit — 2026-09-05

The frozen Simplify snapshot fetched at `2026-09-05T18:06:57.425Z` contains
2,177 raw rows, 1,819 technically eligible rows, 1,138 exact route shapes and
681 browser candidates. Its content hash is
`01c9b1b7ca6b226207a77e6be8c39c33535b13ad4d987477b31930289ed5b08b`.

Every eligible URL received a production-validator HTTP attempt. Earlier
size-limit failures were fetched again after incorporating main's bounded-prefix
inspection support from PR #160. Evidence was captured without credentials,
with four workers and at most one active URL per host. This is complete HTTP
attempt coverage of that snapshot, **not** complete rendered-browser coverage,
proof that every destination is live, or production rollout acceptance.

## Shared repairs

- A complete, matching single structured posting is no longer rejected solely
  because its page contains eight or more navigation/related-job links.
- A matching single-posting prefix from a truncated response remains hidden and
  becomes `unresolved`, so the browser-verification path can inspect it. It is
  not prematurely admitted or permanently classified as an aggregate board.
- Generic redirects, multiple structured postings, repeated evidence across
  different postings, unrelated role content and ID-only shells remain guarded.
- No employer names, host allowlists, employer mappings or special-case routes
  were introduced. The existing numerical health thresholds were not relaxed.

Replaying all 1,819 captured responses with the shared repairs changes 20
aggregate classifications to posting detail and 57 to unresolved. The latter
are still ineligible pending stronger evidence.

| Final HTTP-evidence classification | Count |
| --- | ---: |
| Posting detail | 1,285 |
| Application form | 337 |
| Unresolved | 112 |
| Aggregate board | 70 |
| Blocked/uninspectable | 15 |

These counts describe the classifier, not canonical publication or alert
eligibility. Exact-route classifications can rely on route evidence when HTTP
inspection fails. Seven HTTP-only source URLs were separately rejected by the
HTTPS guard before the eligible inventory was formed.

## Verification and remaining acceptance

Regression coverage uses fictional employers and custom URL hosts, tests link
counts 7/8/10/14/17/100, and exercises both HTTP and rendered evidence. It checks
admission as well as classification, plus truncated-to-complete recovery and
contradictory-evidence precedence. The production-sized health/migration suites
retain all rows and assertions with a 20-second test timeout for shared runners.

The full rendered-browser audit remains outstanding. No connected browser
surface was available during the first audit, and native Chrome actions were
refused while the user's session changed. A dedicated browser session or idle
Chrome is required before certifying the full per-route audit. Mismatch/conflict
resolution and the post-activation identity/index/outbox audit are separate
acceptance work; HTTP counts alone cannot certify them.

The trusted catalog and alert gates remain disabled. Follow the deployment
runbook's quiet-baseline and separate reviewed alert-activation sequence only
after the remaining evidence and owner approval are recorded.

Local detailed evidence is retained in `.context/trusted-rollout-full-http/`
and `.context/provider-neutral-repair/`, including per-URL HTTP outcomes,
pre-refresh evidence, classification replay, test logs and deployment checks.
