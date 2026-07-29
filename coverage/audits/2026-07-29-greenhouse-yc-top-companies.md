# Greenhouse audit: YC and top companies

Audit date: 2026-07-29

This audit originally expanded the Greenhouse discovery backlog without
changing the reviewed source registry. Later on 2026-07-29, the owner approved
an owner-only bulk rollout: current API board identities entered the official
registry as published sources, with ownership review continuing afterward.

## Results

| Cohort | Companies checked | Matching boards | New board tokens |
| --- | ---: | ---: | ---: |
| Y Combinator top companies | 91 | 31 | 28 |
| Maintained top-company roster | 47 | 16 | 6 |
| FAANG subset | 5 | 0 | 0 |

The combined audit added 34 unique candidates. Together with the 132 tokens
known before this pass, the discovery backlog contains 166 unique
API-responsive Greenhouse board tokens.

### New YC candidates

`airbnb`, `algolia`, `amplitude`, `bird`, `brex`, `checkr`, `clever`,
`coinbase`, `dropbox`, `fivetran`, `flexport`, `gitlab`, `goatgroup`, `groww`,
`gusto`, `instacart`, `mixpanel`, `momentus`, `odeko`, `oklo`, `pagerduty`,
`reddit`, `smartasset`, `stripe`, `truebill`, `twitch`, `weave`, `webflow`

`ginkgobioworks`, `faire`, and `scaleai` also matched but were already known.
Corporate suffixes explained the Ginkgo Bioworks, Gusto, and Momentus name
differences. The `truebill` token currently identifies Rocket Money and needs
explicit rebrand evidence before admission.

### New top-company candidates

`databricks`, `janestreet`, `mongodb`, `optiver`, `pinterest`, `roblox`

The top-company pass also reproduced known boards for Airbnb, Anthropic,
Cloudflare, Coinbase, Datadog, Figma, IMC, Jump Trading, SpaceX, and Stripe.
The `linkedin` token was rejected because its board identity was
`LI Test Company`.

No matching Greenhouse board was found for Google, Amazon, Apple, Meta, or
Netflix in this bounded pass. That is a discovery result, not proof that a
company has never used Greenhouse.

## Evidence and limitations

- YC company names, slugs, websites, and top-company membership came from the
  official YC company directory.
- Top-company membership came from the maintained company weights in
  `src/config/weights.ts`.
- Candidate tokens were bounded variants of directory slugs and company names.
- Every counted match responded through `boards-api.greenhouse.io`; the
  LinkedIn mismatch was excluded.
- Board identity alone does not prove that the employer's current first-party
  careers page owns or links to the token.
- Live role counts are time-dependent. At audit time, Stripe had one and
  Databricks had two roles that passed the technical-internship classifier among
  the newly discovered boards.

## Admission work remaining

Each candidate must retain discovery provenance, pass a fresh fixed-host probe,
and be corroborated by its current first-party careers page. Shared boards,
subsidiaries, rebrands, recruiting programs, and non-Greenhouse application
hosts stop for explicit review.

Candidates with eligible roles can then receive sanitized identity, jobs, and
approval fixtures and enter the active registry as `shadow`. Zero-eligible
boards belong in the lower-frequency verified index once that index exists.
Publication still requires scheduled shadow evidence and an explicit reviewed
promotion.

The full workflow and promotion criteria are defined in
[`../../docs/greenhouse/registry-expansion-plan.md`](../../docs/greenhouse/registry-expansion-plan.md).
