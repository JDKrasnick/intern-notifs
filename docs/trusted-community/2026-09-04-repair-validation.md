# Trusted-community repair validation

This validates the three findings against PR #159's original reviewed head
`8cf74e4df6a88df9b92ae9e647d0b1e506a99d46`. The catalog gate and source alert
policy remain disabled. No production migration, activation, notification,
or application submission was performed.

## Repaired behavior

- Standard-source admission repairs do not create delayed alerts, whether the
  trusted catalog gate is off or on. Trusted delayed promotion requires the
  active reviewed alert policy and durable eligible qualification.
- Rollback drains all durable trusted admissions in bounded slices, including
  absent and closed occurrences. It can progress without upstream access,
  preserves independent official admission, and retains a pending checkpoint
  across interruption or reversal.
- Validated trusted occurrences returning after omissions reopen their
  canonical jobs while retaining identity, discovery/visibility timestamps and
  notification history. They cannot override an official closure.

## Historical replay

Replayed 37 consecutive real Simplify revisions from September 4
01:31:01Z through 20:31:23Z, ending at upstream commit
`218d0aa42e2de9206b78363f017673e430644dd8`.

| Result | Before repair | After repair |
| --- | ---: | ---: |
| Distinct open source occurrences incorrectly retained closed | 12 | 0 |
| Snapshots containing incorrectly closed occurrences | 11 | 0 |
| Incorrectly closed canonical jobs in repaired replay | Not counted | 0 |
| Source health failures | 0 | 0 |
| Dormant-policy outbox events | 0 | 0 |

The separate 404 injection hides the affected destination. Hide/re-admit
preserves its original first-visibility timestamp. Historical Markdown is
real; historical destination evidence is simulated because past HTTP responses
are unavailable. This replay does not establish historical page availability.

## Live employer-page sample

At approximately 2026-09-04 22:38 UTC, fetched 11 current employer destinations
from a fresh Simplify snapshot using the production HTTP validator. Each
destination returned HTTP 200 for HEAD and GET. No credentials were supplied.

| Employer / platform | Production inspection result |
| --- | --- |
| NISC / Greenhouse | Application form |
| Hermeus / Lever | Standard application route; HTML exceeded inspector size limit |
| Primer / Ashby | Application form |
| TJX / Workday | Posting route |
| Goldman Sachs | Posting route |
| Westinghouse | Posting details |
| Amazon | Posting details |
| Nokia / Oracle | Unresolved; HTML did not prove a posting |
| Corning | Posting details |
| Keysight / iCIMS | Posting details |
| Altamira / Jobvite | Posting details |

The [Hermeus application form](https://jobs.lever.co/hermeus/5b08e2df-c9db-4831-aece-67d89e744796/apply)
was also independently retrieved and confirmed to show the internship and
application fields. The production inspector's size limit was not changed.
No browser automation connection was available to validate Nokia's rendered
page; it remains unverified and is correctly withheld.

Replayed the captured destination evidence locally as a deliberately
identity-unconfirmed role across two simulated complete snapshots and a retry,
using an alert-enabled policy only in the isolated simulation. Each of the ten
route-admitted samples produced outbox counts **0, 1, 1**. Nokia produced
**0, 0, 0** and stayed hidden. These are simulations of a captured response,
not two independent live observations, production alerts, or proof that every
route supplied a fully inspected job description.

This sample does not replace the complete owner-controlled route/failure-class
audit required before rollout.

## Repository verification

- Full suite: 1,164 passed; 284 live tests skipped.
- Focused persistence/reconciliation boundary suites: 75 passed.
- Typecheck, lint, TypeScript build, Worker dry-run build and diff checks passed.
- Added regressions cover gate-off standard repairs, trusted promotion gating,
  reappearance, absent-open/closed rollback, offline rollback, interrupted
  rollback reversal and preservation of official admission.

Detailed local evidence is retained under `.context/repair159-current/`:
`replay-recent.json`, `live-pages.json`, `dormant-fixed.json`, and check logs.
