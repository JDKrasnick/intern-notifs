CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER
);

CREATE INDEX auth_rate_limits_cleanup ON auth_rate_limits(window_started_at, blocked_until);
