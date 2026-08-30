PRAGMA foreign_keys = ON;

-- A second uniqueness boundary prevents a malformed alias key from claiming the
-- same normalized alias twice under different primary keys.
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_posting_alias_value
  ON catalog_items(json_extract(value, '$.alias'))
  WHERE kind = 'posting-alias';

CREATE TABLE posting_identity_review_candidates (
  id TEXT PRIMARY KEY,
  review_family_key TEXT NOT NULL,
  sanitized_signature TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'approved', 'rejected', 'superseded'))
);

CREATE INDEX posting_identity_review_candidates_queue
  ON posting_identity_review_candidates(state, occurrence_count DESC, last_observed_at DESC);

CREATE TABLE posting_identity_review_candidate_occurrences (
  candidate_id TEXT NOT NULL REFERENCES posting_identity_review_candidates(id),
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, source_id, external_id)
);

CREATE TABLE posting_identity_review_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES posting_identity_review_candidates(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  contract_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);

-- Reviewer decisions are an append-only audit ledger. Supersession is a new
-- decision/candidate state, never mutation of the historical decision.
CREATE TRIGGER posting_identity_review_decisions_no_update
BEFORE UPDATE ON posting_identity_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'posting identity review decisions are immutable');
END;

CREATE TRIGGER posting_identity_review_decisions_no_delete
BEFORE DELETE ON posting_identity_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'posting identity review decisions are immutable');
END;
