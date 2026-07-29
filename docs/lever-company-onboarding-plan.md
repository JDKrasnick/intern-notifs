# Lever company onboarding plan

## Goal

Create a repeatable, human-reviewed process for adding employers to the Lever
ingestion system without guessing company identifiers, trusting aggregators, or
publishing unverified application links.

This plan begins with an employer the owner wants to track. It does not create
a global company directory and does not automatically promote discovery
results.

The shared reader boundary is defined in `ingestion-architecture.md`. Ongoing source
health is defined in `lever-monitoring-plan.md`.

## Research facts

Lever namespaces published jobs under a unique company `SITE`. Lever says that
site is usually the company name without spaces, but its public Postings API
does not provide company search or an authoritative employer-identity field.
It also supports separate global and EU regions.

Consequently:

- an employer name is not a safe production API input;
- a successful API response proves that a Lever site exists, not that it belongs
  to the intended employer;
- ownership must be established from an employer-controlled careers page;
- region is part of source identity because global and EU use different API and
  application hosts.

Official references:
[Lever Postings API](https://github.com/lever/postings-api) and
[Lever Career Site Options](https://help.lever.co/hc/en-us/articles/20087346449437-Lever-Career-Site-Options).

## Admission evidence

Each candidate company must have:

```text
canonical employer ID
catalog display name
explicit aliases
official careers-page URL
Lever region: global or EU
exact Lever site
evidence timestamp
observed hosted/application hosts
shadow or published status
```

Admission requires two independent checks:

1. An employer-controlled careers page links to, embeds, or loads the exact
   regional Lever site.
2. The corresponding fixed Lever endpoint returns a valid postings array whose
   posting IDs are unique and whose hosted/application URLs consistently match
   that same region, site, and posting ID.

The API payload cannot replace the first check because it does not return a
trusted company identity field.

## Stage 1 — Produce review candidates

Start from the owner-approved employer roster and official careers URLs.

The existing `discover:lever` script can remain a lead generator, with these
changes:

- probe both global and EU regions;
- cap concurrency and total attempts;
- store safe status/failure categories instead of silently dropping all failed
  probes;
- record sample posting/application paths without storing full descriptions;
- mark every result `needs-human-approval`;
- never edit the reviewed registry or enable a production adapter.

Slug guesses based on company names or aliases are discovery hints only. They
are not evidence of employer ownership.

### Review-queue output

```json
{
  "employerId": "example",
  "displayName": "Example",
  "officialCareersUrl": "https://example.com/careers",
  "candidateRegion": "global",
  "candidateSite": "example",
  "rawPostingCount": 42,
  "observedHosts": ["jobs.lever.co"],
  "status": "needs-human-approval"
}
```

Do not include credentials, full descriptions, or applicant data.

## Stage 2 — Verify employer ownership and source shape

An operator reviews the official careers page and records how it connects to
Lever:

- direct link to a Lever job site or posting;
- employer-controlled embedded Lever listing;
- employer-controlled frontend request to the Postings API.

Then run an explicit probe using the reviewed region and site. The probe must
build its request from the fixed regional host and one encoded site segment; it
must never accept a complete arbitrary URL.

The probe reports:

- HTTP and JSON outcome;
- raw row count;
- unique/duplicate posting IDs;
- valid and invalid row counts;
- hosted/application host and path summaries;
- technical early-career candidate count;
- included and excluded title samples;
- ETag presence and normalized content hash.

It performs no write to the production registry or catalog.

Reject the candidate when:

- the only ownership evidence comes from an aggregator or third-party list;
- the employer-controlled site does not support the claimed Lever site;
- the source requires authentication, CAPTCHA bypass, or other circumvention;
- URLs point to a different region/site or an unreviewed destination;
- the response cannot be obtained as a complete public postings snapshot;
- the employer identity remains ambiguous.

## Stage 3 — Add reviewed configuration and evidence

After approval, add a `shadow` registry entry and checked-in evidence:

```text
test/fixtures/lever/{region}-{site}/
  approval.json
  postings.json
```

`approval.json` records:

- source and employer IDs;
- official careers URL;
- reviewed region and site;
- review and evidence timestamps;
- raw/eligible counts at review time;
- host/path summary;
- reviewer-approved status.

`postings.json` is a minimized, sanitized deterministic fixture. It should
retain enough representative source structure to exercise real mapping without
becoming an archival copy of every live job description.

CI's Lever manifest must reject:

- a registry entry without both evidence files;
- mismatched source IDs, region, or site;
- expired or malformed evidence timestamps according to the chosen review
  policy;
- fixtures that do not pass the real adapter;
- a fixture whose application URLs violate the registry contract.

## Stage 4 — Shadow evaluation

Shadow mode fetches and maps the board on its scheduled cadence but does not
publish roles or notify students.

Review:

- complete-fetch success and latency;
- raw, valid, eligible, filtered, and withheld counts;
- included and excluded role samples;
- technical-role false positives and false negatives;
- compensation and requirement extraction;
- application URL validity;
- overlap and deduplication with existing catalog sources;
- source stability across changed and unchanged snapshots.

Promotion is a policy decision, not an automatic timer. Require:

- repeated complete successful snapshots;
- no unexplained schema or pagination rejection;
- no region/site/application-host violation;
- reviewed classification quality;
- a successful quiet-baseline rehearsal;
- operator sign-off on the evidence.

Boards with no current internships may remain approved in shadow or quiet mode;
their absence of eligible roles is not itself an admission failure.

## Stage 5 — Publish

Promotion changes only the reviewed source's status from `shadow` to
`published`. The system registry then generates both the scheduled adapter and
its quality policy.

Before merge:

1. run unit, manifest, and fixture tests;
2. run the source's live contract;
3. inspect its source-quality report;
4. verify the first production snapshot is a quiet baseline;
5. confirm monitoring and pause/replay controls recognize the source ID;
6. update `docs/product-roadmap.md` and the employer roster status.

Add companies in small review batches. This keeps the evidence review bounded
and makes it easier to distinguish a provider-wide change from one employer's
unusual board.

## Removal and correction

- Use `shadow` or an operator pause for an uncertain source; do not delete its
  configuration during an incident.
- Correct a region/site or employer-identity error through a new reviewed
  evidence record.
- Preserve prior evidence in Git history.
- Never let removal of the adapter immediately close catalog roles. Snapshot
  reconciliation and source-occurrence rules control closure.

## Acceptance criteria

- No free-form employer input can trigger an unreviewed production request.
- Every Lever source is traceable to an employer-controlled careers page.
- Region and site are explicitly reviewed rather than inferred at runtime.
- Discovery artifacts cannot publish jobs.
- Every reviewed company has approval evidence and deterministic fixtures.
- Shadow results are observable but cannot notify users.
- Publishing is a one-field status change that enables adapter and policy
  together.
- The first production snapshot is quiet.
- An operator can reproduce why a company was admitted and which URL/identity
  checks passed.
