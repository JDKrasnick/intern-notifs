CREATE TABLE gmail_connections (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  refresh_token TEXT NOT NULL,
  history_id TEXT,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('syncing', 'connected', 'error')),
  last_success_at TEXT,
  next_sync_at TEXT NOT NULL,
  lease_until TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX gmail_connections_due ON gmail_connections(next_sync_at, lease_until);

CREATE TABLE gmail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);

CREATE TABLE gmail_processed_messages (
  user_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_key)
);
CREATE INDEX gmail_processed_messages_expiry ON gmail_processed_messages(expires_at);

CREATE TABLE gmail_detections (
  detection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  message_date TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  candidates TEXT NOT NULL,
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (user_id, message_key)
);
CREATE INDEX gmail_detections_user ON gmail_detections(user_id, message_date DESC);
CREATE INDEX gmail_detections_expiry ON gmail_detections(expires_at);

CREATE TABLE gmail_detection_resolutions (
  user_id TEXT NOT NULL,
  detection_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('accept', 'dismiss')),
  job_id TEXT,
  resolved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, detection_id)
);
CREATE INDEX gmail_detection_resolutions_expiry ON gmail_detection_resolutions(expires_at);
