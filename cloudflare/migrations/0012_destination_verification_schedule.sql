CREATE TABLE IF NOT EXISTS destination_verification_schedule (
  occurrence_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  candidate_url TEXT NOT NULL,
  provider_identity TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_enqueued_at TEXT,
  last_completed_at TEXT,
  last_classification TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS destination_verification_schedule_due
  ON destination_verification_schedule(next_check_at, lease_until);

CREATE TABLE IF NOT EXISTS destination_verification_completions (
  idempotency_key TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_backfill_generations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  total INTEGER NOT NULL,
  queued INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_backfill_items (
  generation_id TEXT NOT NULL REFERENCES admission_backfill_generations(id),
  ordinal INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  candidate_url TEXT NOT NULL,
  provider_identity TEXT NOT NULL,
  occurrence_snapshot_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(generation_id, occurrence_key),
  UNIQUE(generation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS admission_backfill_items_progress
  ON admission_backfill_items(generation_id, state, ordinal);

-- Historical evidence is immutable candidate input. It cannot change catalog
-- JSON or projections until an exact guarded repair stage is owner-approved.
CREATE TABLE IF NOT EXISTS admission_backfill_evidence (
  generation_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  classification TEXT NOT NULL,
  value TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(generation_id, occurrence_key),
  FOREIGN KEY(generation_id, occurrence_key)
    REFERENCES admission_backfill_items(generation_id, occurrence_key)
);
