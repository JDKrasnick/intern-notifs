# ETag conditional polling investigation

Issue [#82](https://github.com/JDKrasnick/intern-notifs/issues/82) tracked
provider ETags that were present in every inspected checkpoint but produced no
recorded `success_unchanged_304` outcomes through 2026-08-10.

## Live sample

On 2026-08-19, each endpoint received one normal request followed immediately
by two requests with the returned validator copied verbatim into
`If-None-Match`. The sample records only statuses and validator properties; raw
validator values are intentionally omitted.

| Provider | Reviewed boards | Conditional polls | 304 | 200 with unchanged validator |
|---|---|---:|---:|---:|
| Greenhouse | Figma, Datadog, Cloudflare | 6 | 6 | 0 |
| Lever | Palantir, PlusAI, Hermeus | 6 | 0 | 6 |

All six initial responses returned weak ETags. Query parameters stayed exactly
the same between the initial and conditional requests. Greenhouse reliably
honored the weak validators. Lever returned complete 200 responses even though
the weak validators did not change.

## Decision

- **Greenhouse:** retain conditional requests. The client already sent the
  stored value exactly, but its 304 result omitted `unchangedReason`, causing
  the metrics path to classify real conditional hits as hash-detected unchanged
  responses. The adapter now labels those responses as `not_modified`.
- **Lever:** remove conditional requests and stop persisting response ETags.
  Lever pagination already requires complete retrieval for boards with more
  than one page, and the endpoint did not honor validators for single-page
  samples. Stable whole-board content hashing remains the unchanged fallback.

The ingestion event and embedded metrics expose only three low-cardinality
signals: conditional request attempted, 304 received, and validator changed.
Checkpoint hashes, active posting IDs, catalog reconciliation, and quiet
baseline behavior are unchanged.
