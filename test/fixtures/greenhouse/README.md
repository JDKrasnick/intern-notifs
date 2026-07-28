# Greenhouse per-company evidence

Every entry in `reviewedGreenhouseSources` must ship matching material in this
directory or `npm run greenhouse:manifest` (and CI) fails. This is the
registry-to-fixture manifest gate from Part 1 of the ingestion plan.

Layout per reviewed board:

```
test/fixtures/greenhouse/{boardToken}/
  identity.json   # sanitized board-identity response (the { "name": ... } body)
  jobs.json       # sanitized jobs?content=true response; deterministic, no tracking params
  approval.json   # approval artifact from the manually reviewed live run
```

The gate checks content, not just presence:

- `identity.json` `name` must match that board's `expectedBoardNames`.
- every `jobs.json` row must be a documented Greenhouse job shape whose
  `absolute_url` is https, free of query strings, and on one of that board's
  `allowedInitialHosts` — this is how a company's real host pattern is covered.
- `jobs.json` must contain at least one eligible technical early-career role,
  one non-eligible role, and one prospect post (`internal_job_id: null`).

`test/greenhouse-fixtures.test.ts` then drives each board's material through the
real adapter, so a new company cannot be admitted with unproven mapping.

`approval.json` required fields (keep it small — never store the full payload):

```json
{
  "sourceId": "greenhouse-{boardToken}",
  "runAt": "2026-07-24T18:00:00Z",
  "commitSha": "abc1234",
  "counts": { "raw": 0, "eligible": 0, "withheld": 0 },
  "hostSummary": "job-boards.greenhouse.io"
}
```

Do not commit whole live descriptions or unredacted URLs with tracking
parameters. A fixture directory with no matching reviewed source also fails the
gate.
