-- Publication requires both an exact reviewed receipt and a deployment cohort.
-- These rows do not make a role visible or alter its lifecycle.
CREATE TABLE shadow_publication_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key),
  policy_version TEXT NOT NULL,
  accepted_fields TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX shadow_publication_receipt_revision ON shadow_publication_receipts(job_id, source_id, external_id, content_hash, run_key);
CREATE INDEX shadow_publication_receipt_active ON shadow_publication_receipts(revoked_at, source_id, external_id, content_hash);
