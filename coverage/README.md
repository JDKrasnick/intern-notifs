# Company coverage

This directory tracks how much of the technical-internship employer universe
InternNotifs can currently see. It is provider-neutral: Greenhouse, Lever, open
internship lists, and future first-party integrations all contribute to the same
company record.

There is no authoritative list of every technology company or every company
that offers internships. The checked-in snapshot therefore makes narrower,
auditable claims:

- **Internship observed** means at least one current technical-internship row
  appeared in a configured public source at generation time.
- **Direct published** means InternNotifs reads a reviewed employer ATS source
  in production.
- **Direct shadow** means a reviewed ATS source is being evaluated but cannot
  publish or notify.
- **Candidate only** means the company is in a maintained technology-company
  seed set but no current internship was observed.

`companies.json` is generated data. Every company includes its evidence source
IDs, source-listing observation count, seasons, and direct-source status.
Observations are not presented as unique jobs because the same role can occur in
more than one feed. `summary.ts` is the small
API-facing projection used by the app.

## Refresh

```sh
npm run coverage:companies -- --generated-at 2026-07-29T00:00:00.000Z
```

Omit `--generated-at` for an operational refresh. The command fetches all
configured production sources, normalizes aliases, merges reviewed direct ATS
registries, and writes the snapshot. A source failure aborts the refresh rather
than silently reducing coverage.

## Interpreting the numbers

Coverage is a discovery backlog, not a marketing total. An observed company can
still rely only on a community-maintained listing; a direct source can have zero
eligible internships today; and “candidate only” does not prove that a company
offers internships. The app labels these states separately.

Source definitions and licensing notes live in
[`sources.json`](sources.json). The research and expansion process is documented
in [`../docs/greenhouse-registry-expansion-plan.md`](../docs/greenhouse-registry-expansion-plan.md).
