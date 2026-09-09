ALTER TABLE shadow_extraction_runs
ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy-unknown'
CHECK (origin IN ('provider-poll', 'scheduled-verification', 'controlled', 'backfill', 'legacy-unknown'));

CREATE INDEX shadow_extraction_runs_natural_origin
ON shadow_extraction_runs(schema_version, origin, state, created_at);
