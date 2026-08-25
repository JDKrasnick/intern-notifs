CREATE TABLE usage_counters (
  period TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, metric)
);
