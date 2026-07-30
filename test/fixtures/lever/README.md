# Lever per-site ownership evidence

Lever's Postings API has no identity endpoint. A 200 from
`GET /v0/postings/{site}` proves a site exists; it never says who owns it, and a
wrong guess returns a perfectly healthy board of somebody else's jobs. So
ownership is established once, from a page the employer controls, and recorded
here. `npm run lever:manifest` (and CI) fails if a reviewed board's claim is not
supported by what is in this directory.

Layout per candidate:

```
test/fixtures/lever/{site}/
  evidence.json   # the ownership decision and the markup that proved it
  probe.json      # the read-only probe result the decision was made against
```

A directory here does not mean the board is admitted. Directories for candidates
in a non-admissible state are the exception queue, which a person works; the gate
only requires that every record be well-formed. A board reaches
`reviewedLeverSources` when its evidence is `ownership-verified`, and it enters as
`shadow`.

## `evidence.json`

```json
{
  "site": "geocomply-2",
  "displayName": "GeoComply",
  "careersUrl": "https://www.geocomply.com/careers/",
  "firstPartyEvidenceUrl": "https://www.geocomply.com/careers/",
  "evidenceExcerpt": "<a href=\"https://jobs.lever.co/geocomply-2\">See open roles</a>",
  "observedJobUrl": "https://jobs.lever.co/geocomply-2/{id}/apply",
  "initialHosts": ["jobs.lever.co"],
  "region": "global",
  "state": "ownership-verified",
  "verifiedAt": "2026-07-30T00:00:00Z"
}
```

`evidenceExcerpt` is the difference between an audit trail and a claim: it is the
actual markup containing `jobs.lever.co/{site}`, so a reviewer confirms the
conclusion without repeating the search. The gate checks content, not presence:

- `evidenceExcerpt` must contain `jobs.lever.co/{site}` with a boundary, so
  `jobs.lever.co/cirrus-2` cannot vouch for `cirrus`;
- `firstPartyEvidenceUrl` must be https, on the same registrable domain as
  `careersUrl`, and on neither `lever.co` nor any aggregator;
- `observedJobUrl` must be a posting under `/{site}`;
- `initialHosts` must stay on `jobs.lever.co` unless the state is
  `custom-host-review`;
- `region` is recorded, never inferred.

`state` is one of `ownership-verified`, `api-live-unattributed`,
`ambiguous-owner`, `subsidiary-or-regional`, `custom-host-review`,
`stale-or-reassigned`, `inconclusive`. Only the first is admissible.
`api-live-unattributed` is the state a live board with no first-party link lands
in, and it is never admissible — this is where Lever differs from Greenhouse,
which can sit on the strength of a board name.

## `probe.json`

The output of `npm run lever:probe -- {site}`, verbatim. It carries
`attribution: "unattributed"` as a literal: the probe supplies the numbers, never
the owner. Keep it small — counts, host summary, and a few titles, never whole
descriptions or URLs with tracking parameters. The manifest validates the
envelope, timestamp, single-site result, and site match. An
`ownership-verified` record additionally requires an `ok`, global,
unattributed probe with zero malformed rows, zero URL-contract violations, and
no application host outside `jobs.lever.co`.
