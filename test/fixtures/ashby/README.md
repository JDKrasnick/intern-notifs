# Ashby admission fixtures

Each reviewed board has one metadata-only `probe.json` and one human-reviewed
`evidence.json`. Probe artifacts intentionally omit descriptions and all details
about unlisted jobs. Evidence must point to an employer-controlled page carrying
the exact, case-sensitive Ashby board path.

Etched, Deepgram, Cohere, Mistral AI, and Partly are the initial shadow cohort.
Sixteen owner-approved expansion boards were admitted on 2026-08-09; all new
boards remain shadowed until they independently satisfy the promotion gate.

The headed companion deliberately does not need page HTML fixtures: its
deterministic page-shape tests live in `test/ashby-headed.test.ts`. They cover
the exact approved route, malformed/redirected routes, shadow boards,
verification, ambiguous contact labels, and user-only field types without
retaining employer-page data.
