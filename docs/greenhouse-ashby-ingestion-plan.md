# Greenhouse and Ashby ingestion plan

## Goal

Extend the catalog through reliable, employer-published Greenhouse and Ashby job-board data while preserving the product's direct-to-employer, technical-internship focus.

## System design

1. Maintain a reviewed board registry as the source of truth. Each record identifies the employer, ATS provider, public board identifier, expected application domains, polling policy, review state, and owner.
2. Implement provider adapters that consume public structured job-board data and map it into the shared listing model. Do not use employer credentials, browser automation, or application submission APIs for catalog ingestion.
3. Make Greenhouse and Ashby adapters instances of one provider-agnostic ingestion contract: fetch a snapshot, validate its schema, normalize listings, report source health, and produce a reconciled result.
4. Admit boards through shadow mode first. Collect output, quality results, coverage, and stability data without publishing roles or sending notifications; promote only after review.
5. Poll sources as isolated work items with provider-aware concurrency, jitter, bounded retries, and circuit breaking. This supports frequent updates without allowing a provider or one broken board to degrade the complete catalog.
6. Reconcile each successful response as a current board snapshot. Add new roles, update changed roles, and close a source reference when it disappears; close the catalog role only when no active source remains.
7. Apply shared publication gates: technical early-career relevance, official HTTPS application destination, live-link validation, deduplication, source provenance, and quality/drift checks.

## Coverage and trust

There is no complete public directory of every Greenhouse or Ashby board. Coverage therefore means every approved board in the registry, not an unprovable claim to index every employer globally. Grow the registry through reviewable discovery and measure active boards, roles per board, freshness, invalid-link rate, duplicate rate, and time from employer publication to catalog availability.

## Operational safeguards

Keep raw-response evidence only as necessary for debugging and schema-drift analysis; never collect applicant data. Track provider and board health through the shared reliability system, quarantine unstable boards, and require fixture-based contract tests before promoting adapter changes.
