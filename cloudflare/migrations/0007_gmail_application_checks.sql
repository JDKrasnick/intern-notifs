CREATE TABLE IF NOT EXISTS gmail_application_checks (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  clicked_at TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 0 CHECK (attempt_index BETWEEN 0 AND 4),
  next_check_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'detected', 'expired')),
  detected_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS gmail_application_checks_due
  ON gmail_application_checks(status, next_check_at);

CREATE INDEX IF NOT EXISTS gmail_application_checks_expiry
  ON gmail_application_checks(expires_at);
