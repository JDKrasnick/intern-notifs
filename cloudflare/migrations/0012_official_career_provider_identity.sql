-- The official career hosts approved for exact posting identity are also
-- admission providers. Their fixed tenants identify one canonical employer,
-- so new community occurrences must not depend on the old GitHub row mapping.
INSERT OR IGNORE INTO canonical_employers
  (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
VALUES
  ('tesla', 'Tesla', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('meta', 'Meta', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('jane-street', 'Jane Street', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('goldman-sachs', 'Goldman Sachs', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('imc', 'IMC', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

INSERT OR IGNORE INTO employer_mappings
  (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
VALUES
  ('official-career-provider-tesla', 'tesla', 'tesla', 'tesla', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-meta', 'meta', 'meta', 'meta', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-janestreet', 'janestreet', 'janestreet', 'jane-street', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-goldman-sachs', 'goldman-sachs', 'goldman-sachs', 'goldman-sachs', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-imc', 'imc', 'imc', 'imc', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z');

INSERT OR IGNORE INTO admission_reviewer_decisions
  (id, subject_type, subject_id, decision, reason, reviewed_at, reviewed_by)
VALUES
  ('official-career-canonical-tesla', 'canonical-employer', 'tesla', 'approved', 'Official Tesla career host reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-canonical-meta', 'canonical-employer', 'meta', 'approved', 'Official Meta career host reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-canonical-janestreet', 'canonical-employer', 'jane-street', 'approved', 'Official Jane Street career host reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-canonical-goldman-sachs', 'canonical-employer', 'goldman-sachs', 'approved', 'Official Goldman Sachs career host reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-canonical-imc', 'canonical-employer', 'imc', 'approved', 'Official IMC career host reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-mapping-tesla', 'employer-mapping', 'official-career-provider-tesla', 'approved', 'Tesla provider tenant reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-mapping-meta', 'employer-mapping', 'official-career-provider-meta', 'approved', 'Meta provider tenant reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-mapping-janestreet', 'employer-mapping', 'official-career-provider-janestreet', 'approved', 'Jane Street provider tenant reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-mapping-goldman-sachs', 'employer-mapping', 'official-career-provider-goldman-sachs', 'approved', 'Goldman Sachs provider tenant reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review'),
  ('official-career-mapping-imc', 'employer-mapping', 'official-career-provider-imc', 'approved', 'IMC provider tenant reviewed', '2026-09-01T00:00:00Z', 'official-career-route-review');

CREATE TABLE IF NOT EXISTS migration_0012_official_provider_assertion (
  ok INTEGER NOT NULL CONSTRAINT official_provider_mappings_must_match CHECK (ok = 1)
);
DELETE FROM migration_0012_official_provider_assertion;

INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT CASE WHEN COUNT(*) = 5 THEN 1 ELSE 0 END
FROM employer_mappings
WHERE superseded_at IS NULL
  AND (provider, scope, canonical_employer_id) IN (
    ('tesla', 'tesla', 'tesla'),
    ('meta', 'meta', 'meta'),
    ('janestreet', 'janestreet', 'jane-street'),
    ('goldman-sachs', 'goldman-sachs', 'goldman-sachs'),
    ('imc', 'imc', 'imc')
  );

INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT CASE WHEN COUNT(*) = 10 THEN 1 ELSE 0 END
FROM admission_reviewer_decisions
WHERE id IN (
  'official-career-canonical-tesla',
  'official-career-canonical-meta',
  'official-career-canonical-janestreet',
  'official-career-canonical-goldman-sachs',
  'official-career-canonical-imc',
  'official-career-mapping-tesla',
  'official-career-mapping-meta',
  'official-career-mapping-janestreet',
  'official-career-mapping-goldman-sachs',
  'official-career-mapping-imc'
);
