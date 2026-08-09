# Ashby discovery and admission

Ashby admission and ingestion are separate trust stages. Admission discovers
board identities, probes the public contract, and validates committed human
decisions. The public posting adapter then produces strict, listed-only neutral
snapshots for reviewed sources. Neither admission command writes the registry,
publishes a board, sends notifications, or deploys infrastructure. The
independently deployable runtime is documented in
[`ashby-monitoring-runbook.md`](ashby-monitoring-runbook.md); headed-browser work
remains separately scoped.

## Trust boundary

- Learn a board name only from an observed `https://jobs.ashbyhq.com/{board}` URL.
  Preserve case and punctuation exactly; never slugify an employer name.
- A successful API response proves the board exists, not who owns it.
- Ownership requires an employer-controlled HTTPS page containing the exact board
  path. Ashby, aggregators, search results, and archives cannot establish it.
- Initial admission requires at least one listed technical internship, co-op,
  apprenticeship, new-graduate program, or explicitly entry-level role. A later
  closure does not revoke review. Generic titles, prose-only experience ranges,
  and “junior” alone do not qualify.
- The normal application host is `jobs.ashbyhq.com`. Any employer-controlled
  external host requires a recorded justification and human review timestamp.
- Every new source enters `shadow`. Promotion to `published` is a separate human
  decision. No command in this workflow performs either change.
- Geographic coverage is recorded from source fields. It is not evidence of visa
  sponsorship or work authorization. Those signals belong to the provider-neutral
  follow-up tracked in GitHub issue #56.

## Read-only commands

```sh
npm run ashby:ledger
npm run ashby:probe -- etched Deepgram --out artifacts/ashby-probes.json
npm run ashby:manifest
npm run ashby:reverify
npm run test:ashby:live
```

`ashby:ledger` scans the weekly catalog sources and writes the full candidate
review artifact. The weekly source-discovery workflow uploads that artifact even
when another discovery step fails. `ashby:probe` uses only the fixed endpoint
`https://api.ashbyhq.com/posting-api/job-board/{board}` and retains metadata:
version, counts, listed status, exact paths, application hosts, geography, and a
small set of qualifying title samples. It never retains descriptions or details
about unlisted jobs.

`ashby:manifest` is the offline admission gate. It checks evidence age, duplicate
identities, exact ownership links, API/schema/path results, the initial live-role
rule, allowed hosts, and shadow/published status. Probe and admission timestamps
must be within seven days, and future timestamps fail beyond five minutes of
clock skew.
`ashby:reverify` only re-reads employer evidence pages and reports drift.

## Public posting adapter

The adapter and queue worker call
`posting-api/job-board/{exact-board-name}?includeCompensation=true` with a
15-second attempt timeout. It rejects redirects, API version drift, malformed
responses, duplicate UUIDs, invalid publication dates, and wrong-board job or
Ashby application paths. Unlisted rows are removed before hashing and neutral
processing. An external application URL is accepted only when its HTTPS host is
recorded in the reviewed source; an off-allowlist row is withheld and reported
without discarding the rest of a valid snapshot.

Ashby's `employmentType: Intern` is a trusted posting-level lifecycle signal.
Other employment types still require explicit early-career title wording. The
shared processor—not Ashby—decides whether a qualifying role is technical.
`test:ashby:live` is a read-only nightly contract across every reviewed board;
it deploys and publishes nothing.

## Human admission checklist

1. Review the candidate row and its observed company variants. Stop on ambiguity.
2. Run the exact board name through `ashby:probe`; inspect every reported host.
3. Open the employer's official careers page and verify its exact Ashby link.
4. Record only a short excerpt containing that link. Do not copy job descriptions.
5. Justify and timestamp every non-Ashby application host.
6. Commit one `evidence.json` and metadata-only `probe.json` under
   `test/fixtures/ashby/{exact-board-name}/`.
7. Add the provider-neutral reviewed-source record in shadow and run the manifest.
8. A person separately decides whether and when the source may be published.

## Reviewed cohort and fallback order

The reviewed shadow cohort contains the five initial boards plus 16
owner-approved expansion boards. The exact case-sensitive expansion identities
are `notion`, `alan`, `base-power`, `reonic`, `Terranova`, `melius`, `rho`,
`ctgt`, `opusclip`, `windborne-systems`, `persona.ai`, `skydio`, `heliux`,
`beaconsoftware`, `centerfield`, and `rivianvw.tech`.

Enpal, NEURA Robotics, Terminal, and Bild AI were not admitted because they did
not satisfy the exact first-party ownership-evidence gate. Review replacements
in this order: `circleback`, `eragon`, `modal`, `yotta`, `anthelioncap`, then
`saronic`. A fallback is not pre-approved and must pass every normal gate.
