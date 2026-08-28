CREATE TABLE IF NOT EXISTS catalog_admission_occurrence_repair_stage (
  token TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  original_value TEXT NOT NULL,
  proposed_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(token, source_id, external_id)
);
