PRAGMA foreign_keys = ON;

CREATE TABLE catalog_items (
  pk TEXT NOT NULL,
  sk TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  url_key TEXT,
  fingerprint_key TEXT,
  sms_pending INTEGER NOT NULL DEFAULT 0,
  digest_pending INTEGER NOT NULL DEFAULT 0,
  catalog_state TEXT,
  catalog_sort_key TEXT,
  search_text TEXT,
  source_classes TEXT,
  source_id TEXT,
  external_id TEXT,
  PRIMARY KEY (pk, sk)
);

CREATE INDEX catalog_items_url_key ON catalog_items(url_key) WHERE url_key IS NOT NULL;
CREATE INDEX catalog_items_fingerprint_key ON catalog_items(fingerprint_key) WHERE fingerprint_key IS NOT NULL;
CREATE INDEX catalog_items_sms_pending ON catalog_items(sms_pending) WHERE sms_pending = 1;
CREATE INDEX catalog_items_digest_pending ON catalog_items(digest_pending) WHERE digest_pending = 1;
CREATE INDEX catalog_items_state_sort ON catalog_items(catalog_state, catalog_sort_key DESC);
CREATE INDEX catalog_items_source_occurrences ON catalog_items(source_id, external_id);

CREATE TABLE user_items (
  user_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  active_device INTEGER NOT NULL DEFAULT 0,
  device_token TEXT,
  receipt_state TEXT,
  session_id TEXT,
  expires_at INTEGER,
  PRIMARY KEY (user_id, item_key)
);

CREATE INDEX user_items_active_devices ON user_items(active_device) WHERE active_device = 1;
CREATE INDEX user_items_device_token ON user_items(device_token) WHERE device_token IS NOT NULL;
CREATE INDEX user_items_receipt_state ON user_items(receipt_state) WHERE receipt_state IS NOT NULL;
CREATE UNIQUE INDEX user_items_session_id ON user_items(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX user_items_expiry ON user_items(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE auth_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  verified_at TEXT,
  confirmation_hash TEXT,
  confirmation_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
