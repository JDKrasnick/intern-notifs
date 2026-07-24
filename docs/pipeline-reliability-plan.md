# Pipeline reliability and alerting plan

## Goal

Make failures across catalog ingestion and notification delivery visible, recoverable, and actionable without turning normal transient errors into operator noise.

## System design

1. Treat scheduling, worker execution, source retrieval, parsing, source-quality checks, application-link validation, persistence, push delivery, and digests as distinct failure domains. Each emits a structured outcome with a run identifier and the relevant source or job context.
2. Keep recovery separate from alerting. Transient failures retry with bounded backoff; invalid data is quarantined; exhausted work is retained in a domain-specific DLQ; alerts report a condition that needs attention rather than every failed attempt.
3. Move source work to independently retryable units as ingestion grows. A coordinator schedules a run, workers handle individual sources, and one failing board cannot prevent the rest of the catalog from updating.
4. Persist source health alongside catalog checkpoints: last successful fetch, freshness, latency, output count, failure category, and the most recent safe diagnostic evidence. This makes health queryable even when logs expire.
5. Publish operational metrics and dashboards for run success, source freshness, DLQ depth and age, parser/quality failures, invalid-link rate, catalog write failures, and notification delivery outcomes.

## Alerting policy

- **Immediate:** pipeline unavailable, worker or scheduler DLQ messages, data-loss risk, or delivery systems unavailable.
- **Prompt:** a source is repeatedly failing, exceeds its freshness target, or has an unexpected output collapse.
- **Digest:** isolated invalid links, one-off parser rejections, and other non-blocking degradation.

Route alerts through a stable operations sender to Gmail. Apply labels such as `InternNotifs/Operations`, `Scrape`, `Delivery`, and `Infrastructure`; leave new high-severity alerts in the Inbox until their signal quality is proven.

## Recovery and operations

Every alert must identify the failed domain, impact, retry state, and safe next action. Provide replay tooling for DLQ messages, source quarantine controls, and runbooks for common failures. Test alert delivery and recovery paths periodically, not only the happy path.
