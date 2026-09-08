-- Operational state is separate from catalog identity and notification state.
CREATE TABLE IF NOT EXISTS role_metadata_acquisition (
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  lease_until TEXT NOT NULL DEFAULT '',
  retry_after TEXT NOT NULL DEFAULT '',
  observed_at TEXT,
  report TEXT,
  PRIMARY KEY(job_id, source_id)
);
CREATE INDEX IF NOT EXISTS role_metadata_acquisition_due ON role_metadata_acquisition(lease_until, retry_after);

CREATE TABLE IF NOT EXISTS role_metadata_api_backoff (
  host TEXT PRIMARY KEY,
  retry_after TEXT NOT NULL
);
