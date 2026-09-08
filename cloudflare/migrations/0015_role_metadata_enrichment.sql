CREATE TABLE IF NOT EXISTS role_metadata_evidence (
  job_id TEXT NOT NULL,
  source_class TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  extraction_version INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
  PRIMARY KEY(job_id, source_class, source_id, source_url, artifact_hash)
);
CREATE INDEX IF NOT EXISTS role_metadata_evidence_current
  ON role_metadata_evidence(job_id, is_current, extraction_version);

CREATE TABLE IF NOT EXISTS role_metadata_extraction_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  extraction_version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  backfill_token TEXT
);
CREATE INDEX IF NOT EXISTS role_metadata_extraction_latest
  ON role_metadata_extraction_attempts(job_id, source_id, extraction_version, observed_at);

CREATE TABLE IF NOT EXISTS role_metadata_conflicts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  field TEXT NOT NULL,
  applicability_key TEXT,
  evidence_hashes TEXT NOT NULL,
  values_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open', 'resolved')),
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS role_metadata_conflicts_open
  ON role_metadata_conflicts(state, field, updated_at);

CREATE TABLE IF NOT EXISTS role_metadata_repair_stage (
  token TEXT NOT NULL,
  job_id TEXT NOT NULL,
  original_value TEXT NOT NULL,
  proposed_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(token, job_id)
);

CREATE TABLE IF NOT EXISTS role_metadata_repair_guards (
  token TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1),
  applied_at TEXT NOT NULL
);
