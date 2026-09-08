-- Shadow extraction is intentionally isolated from catalog_items and from the
-- deterministic role_metadata_* evidence tables. No row here can publish or
-- repair a public catalog field.
CREATE TABLE shadow_extraction_runs (
  run_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  posting_identity TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  preprocessing_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'disabled', 'completed', 'invalid-output', 'transient-failure', 'obsolete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT NOT NULL DEFAULT '',
  input_key TEXT NOT NULL,
  response_key TEXT,
  validation TEXT,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  actual_cost_cents INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX shadow_extraction_runs_current ON shadow_extraction_runs(state, lease_until, updated_at);
CREATE INDEX shadow_extraction_runs_posting ON shadow_extraction_runs(job_id, source_id, external_id, content_hash);

CREATE TABLE shadow_extraction_posting_revisions (
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(job_id, source_id, external_id)
);

CREATE TABLE shadow_extraction_field_outcomes (
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key) ON DELETE CASCADE,
  field TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present', 'not-stated', 'conflicting', 'incomplete')),
  accepted INTEGER NOT NULL CHECK(accepted IN (0, 1)),
  failure TEXT,
  PRIMARY KEY(run_key, field)
);

CREATE TABLE shadow_extraction_baseline_differences (
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key) ON DELETE CASCADE,
  field TEXT NOT NULL,
  baseline_state TEXT NOT NULL,
  shadow_state TEXT NOT NULL,
  differs INTEGER NOT NULL CHECK(differs IN (0, 1)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_key, field)
);

-- Initial per-run reservation ledger. Migration 0023 preserves these rows and
-- converts the table to per-attempt reservations before live inference exists.
CREATE TABLE shadow_extraction_cost_ledger (
  period TEXT NOT NULL,
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key) ON DELETE CASCADE,
  reserved_cents INTEGER NOT NULL CHECK(reserved_cents > 0),
  actual_cents INTEGER NOT NULL DEFAULT 0 CHECK(actual_cents >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved', 'reconciled', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(period, run_key)
);
