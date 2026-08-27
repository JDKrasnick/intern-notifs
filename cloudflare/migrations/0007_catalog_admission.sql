CREATE TABLE IF NOT EXISTS canonical_employers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  parent_employer_id TEXT,
  brand_of_employer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employer_mappings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL,
  canonical_employer_id TEXT NOT NULL REFERENCES canonical_employers(id),
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  supersedes_mapping_id TEXT REFERENCES employer_mappings(id),
  superseded_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_mappings_active_scope
  ON employer_mappings(provider, scope) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS destination_review_rules (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  provider TEXT NOT NULL,
  tenant TEXT,
  decision TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  sample_due_at TEXT,
  UNIQUE(host, provider, tenant)
);

CREATE TABLE IF NOT EXISTS destination_verification_evidence (
  job_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  classification TEXT NOT NULL,
  value TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(job_id, evidence_hash)
);

CREATE TABLE IF NOT EXISTS destination_verification_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  candidate_url TEXT NOT NULL,
  state TEXT NOT NULL,
  classification TEXT,
  error TEXT,
  attempted_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS admission_incidents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  host TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  grace_deadline TEXT,
  warning_sent_at TEXT,
  quarantine_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS admission_incidents_active ON admission_incidents(state, grace_deadline);

CREATE TABLE IF NOT EXISTS admission_reviewer_decisions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_email_deliveries (
  dedupe_key TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_admission_repair_stage (
  token TEXT NOT NULL,
  job_id TEXT NOT NULL,
  original_value TEXT NOT NULL,
  proposed_value TEXT NOT NULL,
  url_key TEXT NOT NULL,
  fingerprint_key TEXT NOT NULL,
  sms_pending INTEGER NOT NULL,
  digest_pending INTEGER NOT NULL,
  catalog_state TEXT,
  catalog_sort_key TEXT,
  search_text TEXT,
  source_classes TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(token, job_id)
);

CREATE TABLE IF NOT EXISTS catalog_admission_repair_guards (
  token TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1),
  applied_at TEXT NOT NULL
);
