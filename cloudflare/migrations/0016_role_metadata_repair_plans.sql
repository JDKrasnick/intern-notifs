CREATE TABLE IF NOT EXISTS role_metadata_repair_plans (
  token TEXT PRIMARY KEY,
  expected_jobs INTEGER NOT NULL,
  expected_occurrences INTEGER NOT NULL CHECK(expected_occurrences = 0),
  conflict_count INTEGER NOT NULL,
  evidence_snapshot TEXT NOT NULL,
  collection_snapshot TEXT NOT NULL,
  collection_complete INTEGER NOT NULL CHECK(collection_complete IN (0, 1)),
  created_at TEXT NOT NULL
);
