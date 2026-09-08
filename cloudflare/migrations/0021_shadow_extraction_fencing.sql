-- Runs describe one posting revision; cache entries describe reusable inference
-- content. Keeping them separate prevents one posting becoming obsolete from
-- suppressing another posting with identical text.
ALTER TABLE shadow_extraction_runs ADD COLUMN lease_token TEXT;
ALTER TABLE shadow_extraction_runs ADD COLUMN cache_key TEXT;

CREATE INDEX shadow_extraction_runs_cache ON shadow_extraction_runs(cache_key, state);

CREATE TABLE shadow_extraction_claims (
  lease_token TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key) ON DELETE CASCADE,
  claimed_at TEXT NOT NULL
);

CREATE TABLE shadow_extraction_usage (
  lease_token TEXT PRIMARY KEY REFERENCES shadow_extraction_claims(lease_token) ON DELETE CASCADE,
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key) ON DELETE CASCADE,
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  actual_cost_cents INTEGER NOT NULL CHECK(actual_cost_cents >= 0),
  recorded_at TEXT NOT NULL
);

CREATE TABLE shadow_extraction_cache (
  cache_key TEXT PRIMARY KEY,
  response_key TEXT NOT NULL,
  validation TEXT NOT NULL,
  created_at TEXT NOT NULL
);
