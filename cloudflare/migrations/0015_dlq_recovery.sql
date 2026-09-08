CREATE TABLE dlq_repair_plans (
  plan_id TEXT PRIMARY KEY,
  repair_token_hash TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('replay', 'discard')),
  reason TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applying_at TEXT,
  applied_at TEXT
);

CREATE TABLE dlq_repair_plan_items (
  plan_id TEXT NOT NULL REFERENCES dlq_repair_plans(plan_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  message_body TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  source_id TEXT,
  job_id TEXT,
  replayed_at TEXT,
  purged_at TEXT,
  PRIMARY KEY (plan_id, message_id)
);

CREATE TABLE dlq_disposition_audit (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  classification TEXT NOT NULL,
  diagnostic TEXT,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  disposed_at TEXT NOT NULL
);
CREATE INDEX dlq_disposition_audit_age ON dlq_disposition_audit(disposed_at);

CREATE TABLE queue_failure_events (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  delivery_attempt INTEGER NOT NULL,
  message_timestamp TEXT,
  source_id TEXT,
  source_kind TEXT,
  payload_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  diagnostic TEXT NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX queue_failure_message ON queue_failure_events(queue_name, message_id, last_failed_at DESC);
CREATE INDEX queue_failure_age ON queue_failure_events(last_failed_at);
