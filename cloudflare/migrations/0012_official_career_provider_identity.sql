-- The official career hosts approved for exact posting identity are also
-- admission providers. Their fixed tenants identify one canonical employer,
-- so new community occurrences must not depend on the old GitHub row mapping.
-- Exact replay is allowed, but stable reviewed IDs must never silently retain
-- conflicting data. Preflight every payload before adding any new rows.
CREATE TABLE IF NOT EXISTS migration_0012_official_provider_assertion (
  ok INTEGER NOT NULL CONSTRAINT official_provider_rows_must_match CHECK (ok = 1)
);
DELETE FROM migration_0012_official_provider_assertion;

WITH expected(id, display_name) AS (VALUES
  ('tesla', 'Tesla'),
  ('meta', 'Meta'),
  ('jane-street', 'Jane Street'),
  ('goldman-sachs', 'Goldman Sachs'),
  ('imc', 'IMC')
)
INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT 0
FROM canonical_employers AS current
JOIN expected USING (id)
WHERE current.display_name != expected.display_name
  OR current.reviewed_at != '2026-09-01T00:00:00Z'
  OR current.reviewed_by != 'official-career-route-review'
  OR current.parent_employer_id IS NOT NULL
  OR current.brand_of_employer_id IS NOT NULL
  OR current.created_at != '2026-09-01T00:00:00Z'
  OR current.updated_at != '2026-09-01T00:00:00Z';

INSERT OR IGNORE INTO canonical_employers
  (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
VALUES
  ('tesla', 'Tesla', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('meta', 'Meta', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('jane-street', 'Jane Street', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('goldman-sachs', 'Goldman Sachs', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('imc', 'IMC', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

WITH expected(id, provider, scope, canonical_employer_id) AS (VALUES
  ('official-career-provider-tesla', 'tesla', 'tesla', 'tesla'),
  ('official-career-provider-meta', 'meta', 'meta', 'meta'),
  ('official-career-provider-janestreet', 'janestreet', 'janestreet', 'jane-street'),
  ('official-career-provider-goldman-sachs', 'goldman-sachs', 'goldman-sachs', 'goldman-sachs'),
  ('official-career-provider-imc', 'imc', 'imc', 'imc')
)
INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT 0
FROM employer_mappings AS current
JOIN expected USING (id)
WHERE current.provider != expected.provider
  OR current.scope != expected.scope
  OR current.canonical_employer_id != expected.canonical_employer_id
  OR current.reviewed_at != '2026-09-01T00:00:00Z'
  OR current.reviewed_by != 'official-career-route-review'
  OR current.supersedes_mapping_id IS NOT NULL
  OR current.superseded_at IS NOT NULL
  OR current.created_at != '2026-09-01T00:00:00Z';

INSERT OR IGNORE INTO employer_mappings
  (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
VALUES
  ('official-career-provider-tesla', 'tesla', 'tesla', 'tesla', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-meta', 'meta', 'meta', 'meta', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-janestreet', 'janestreet', 'janestreet', 'jane-street', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-goldman-sachs', 'goldman-sachs', 'goldman-sachs', 'goldman-sachs', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z'),
  ('official-career-provider-imc', 'imc', 'imc', 'imc', '2026-09-01T00:00:00Z', 'official-career-route-review', '2026-09-01T00:00:00Z');

WITH expected(id, subject_type, subject_id, reason) AS (VALUES
  ('official-career-canonical-tesla', 'canonical-employer', 'tesla', 'Official Tesla career host reviewed'),
  ('official-career-canonical-meta', 'canonical-employer', 'meta', 'Official Meta career host reviewed'),
  ('official-career-canonical-janestreet', 'canonical-employer', 'jane-street', 'Official Jane Street career host reviewed'),
  ('official-career-canonical-goldman-sachs', 'canonical-employer', 'goldman-sachs', 'Official Goldman Sachs career host reviewed'),
  ('official-career-canonical-imc', 'canonical-employer', 'imc', 'Official IMC career host reviewed'),
  ('official-career-mapping-tesla', 'employer-mapping', 'official-career-provider-tesla', 'Tesla provider tenant reviewed'),
  ('official-career-mapping-meta', 'employer-mapping', 'official-career-provider-meta', 'Meta provider tenant reviewed'),
  ('official-career-mapping-janestreet', 'employer-mapping', 'official-career-provider-janestreet', 'Jane Street provider tenant reviewed'),
  ('official-career-mapping-goldman-sachs', 'employer-mapping', 'official-career-provider-goldman-sachs', 'Goldman Sachs provider tenant reviewed'),
  ('official-career-mapping-imc', 'employer-mapping', 'official-career-provider-imc', 'IMC provider tenant reviewed')
)
INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT 0
FROM admission_reviewer_decisions AS current
JOIN expected USING (id)
WHERE current.subject_type != expected.subject_type
  OR current.subject_id != expected.subject_id
  OR current.decision != 'approved'
  OR current.reason != expected.reason
  OR current.reviewed_at != '2026-09-01T00:00:00Z'
  OR current.reviewed_by != 'official-career-route-review';

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

INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT CASE WHEN COUNT(*) = 5 THEN 1 ELSE 0 END
FROM canonical_employers
WHERE id IN ('tesla', 'meta', 'jane-street', 'goldman-sachs', 'imc')
  AND reviewed_at = '2026-09-01T00:00:00Z'
  AND reviewed_by = 'official-career-route-review';

INSERT INTO migration_0012_official_provider_assertion (ok)
SELECT CASE WHEN COUNT(*) = 5 THEN 1 ELSE 0 END
FROM employer_mappings
WHERE id IN (
    'official-career-provider-tesla',
    'official-career-provider-meta',
    'official-career-provider-janestreet',
    'official-career-provider-goldman-sachs',
    'official-career-provider-imc'
  )
  AND reviewed_at = '2026-09-01T00:00:00Z'
  AND reviewed_by = 'official-career-route-review'
  AND superseded_at IS NULL;

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
)
  AND decision = 'approved'
  AND reviewed_at = '2026-09-01T00:00:00Z'
  AND reviewed_by = 'official-career-route-review';

DROP TABLE migration_0012_official_provider_assertion;
