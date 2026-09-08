-- Cache metadata must not outlive the R2 response artifact it references.
-- Existing entries receive an empty expiry so they are refreshed on first use.
ALTER TABLE shadow_extraction_cache ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';

CREATE INDEX shadow_extraction_cache_expiry ON shadow_extraction_cache(expires_at);
