# Ashby discovery and admission

Ashby admission is a review workflow, not a runtime adapter. It discovers board
identities, probes the public contract, and validates committed human decisions.
It never writes the source registry, publishes a board, or deploys infrastructure.
Adapter, runtime, operations, and headed-browser work remain separate.

## Trust boundary

- Learn a board name only from an observed `https://jobs.ashbyhq.com/{board}` URL.
  Preserve case and punctuation exactly; never slugify an employer name.
- A successful API response proves the board exists, not who owns it.
- Ownership requires an employer-controlled HTTPS page containing the exact board
  path. Ashby, aggregators, search results, and archives cannot establish it.
- Initial admission requires at least one listed technical internship, co-op,
  apprenticeship, or new-graduate role. A later closure does not revoke review.
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
rule, allowed hosts, matching timestamps, and shadow/published status.
`ashby:reverify` only re-reads employer evidence pages and reports drift.

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

## Initial cohort and fallback order

The reviewed shadow cohort is Etched, Deepgram, Cohere, Mistral AI, and Partly.
If first-party evidence stops qualifying before admission, review Alan first and
Notion second. A fallback is not pre-approved: it must satisfy the same observed
URL, current technical early-career role, ownership evidence, host, and manifest
gates.
