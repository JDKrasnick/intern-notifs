-- Issue #50 production review decisions. Official employer materials support
-- these canonical names:
--   https://aquatic.com/disclosures/index.html
--   https://www.jumptrading.com/
--   https://www.squarepoint-capital.com/about
-- Provider board tokens and community spellings remain evidence scopes; they
-- do not become canonical employer IDs themselves.
-- Exact replay is allowed, but a stable reviewed ID must never silently refer
-- to different data. Keep this ordinary table retry-safe in case a migration
-- runner does not roll back DDL after one of the assertions fails.
CREATE TABLE IF NOT EXISTS migration_0011_reviewed_identity_assertion (
  ok INTEGER NOT NULL CONSTRAINT issue_50_reviewed_identity_rows_must_match CHECK (ok = 1)
);
DELETE FROM migration_0011_reviewed_identity_assertion;

INSERT INTO migration_0011_reviewed_identity_assertion (ok)
SELECT 0 FROM canonical_employers
WHERE (id = 'aquatic-capital-management' AND NOT (
    display_name = 'Aquatic Capital Management' AND reviewed_at = '2026-08-30T00:00:00Z'
    AND reviewed_by = 'issue-50-production-review' AND parent_employer_id IS NULL
    AND brand_of_employer_id IS NULL AND created_at = '2026-08-30T00:00:00Z'
    AND updated_at = '2026-08-30T00:00:00Z'))
  OR (id = 'jump-trading' AND NOT (
    display_name = 'Jump Trading' AND reviewed_at = '2026-08-30T00:00:00Z'
    AND reviewed_by = 'issue-50-production-review' AND parent_employer_id IS NULL
    AND brand_of_employer_id IS NULL AND created_at = '2026-08-30T00:00:00Z'
    AND updated_at = '2026-08-30T00:00:00Z'))
  OR (id = 'squarepoint-capital' AND NOT (
    display_name = 'Squarepoint Capital' AND reviewed_at = '2026-08-30T00:00:00Z'
    AND reviewed_by = 'issue-50-production-review' AND parent_employer_id IS NULL
    AND brand_of_employer_id IS NULL AND created_at = '2026-08-30T00:00:00Z'
    AND updated_at = '2026-08-30T00:00:00Z'));

INSERT INTO canonical_employers
  (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
VALUES
  ('aquatic-capital-management', 'Aquatic Capital Management', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
  ('jump-trading', 'Jump Trading', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
  ('squarepoint-capital', 'Squarepoint Capital', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z')
ON CONFLICT(id) DO NOTHING;

-- GitHub community sources are multi-employer documents, so only their
-- reviewed per-row employer scopes are mapped. Official Greenhouse sources
-- use their reviewed source IDs.
INSERT INTO migration_0011_reviewed_identity_assertion (ok)
SELECT 0 FROM employer_mappings
WHERE id IN (
    'issue-50-greenhouse-aquaticcapitalmanagement',
    'issue-50-github-employer-aquatic',
    'issue-50-github-employer-aquatic-capital',
    'issue-50-github-employer-aquatic-capital-management',
    'issue-50-greenhouse-jumptrading',
    'issue-50-github-employer-jump-trading',
    'issue-50-github-employer-jumptrading',
    'issue-50-greenhouse-squarepointcapital',
    'issue-50-github-employer-squarepoint-capital',
    'issue-50-github-employer-squarepointcapital'
  )
  AND NOT (
    provider = CASE WHEN id LIKE 'issue-50-greenhouse-%' THEN 'greenhouse' ELSE 'github' END
    AND scope = CASE id
      WHEN 'issue-50-greenhouse-aquaticcapitalmanagement' THEN 'greenhouse-aquaticcapitalmanagement'
      WHEN 'issue-50-github-employer-aquatic' THEN 'employer:aquatic'
      WHEN 'issue-50-github-employer-aquatic-capital' THEN 'employer:aquatic-capital'
      WHEN 'issue-50-github-employer-aquatic-capital-management' THEN 'employer:aquatic-capital-management'
      WHEN 'issue-50-greenhouse-jumptrading' THEN 'greenhouse-jumptrading'
      WHEN 'issue-50-github-employer-jump-trading' THEN 'employer:jump-trading'
      WHEN 'issue-50-github-employer-jumptrading' THEN 'employer:jumptrading'
      WHEN 'issue-50-greenhouse-squarepointcapital' THEN 'greenhouse-squarepointcapital'
      WHEN 'issue-50-github-employer-squarepoint-capital' THEN 'employer:squarepoint-capital'
      WHEN 'issue-50-github-employer-squarepointcapital' THEN 'employer:squarepointcapital'
    END
    AND canonical_employer_id = CASE
      WHEN id LIKE '%aquatic%' THEN 'aquatic-capital-management'
      WHEN id LIKE '%jump%' THEN 'jump-trading'
      ELSE 'squarepoint-capital'
    END
    AND reviewed_at = '2026-08-30T00:00:00Z'
    AND reviewed_by = 'issue-50-production-review'
    AND supersedes_mapping_id IS NULL
    AND superseded_at IS NULL
    AND created_at = '2026-08-30T00:00:00Z'
  );

INSERT INTO employer_mappings
  (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
VALUES
  ('issue-50-greenhouse-aquaticcapitalmanagement', 'greenhouse', 'greenhouse-aquaticcapitalmanagement', 'aquatic-capital-management', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-aquatic', 'github', 'employer:aquatic', 'aquatic-capital-management', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-aquatic-capital', 'github', 'employer:aquatic-capital', 'aquatic-capital-management', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-aquatic-capital-management', 'github', 'employer:aquatic-capital-management', 'aquatic-capital-management', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-greenhouse-jumptrading', 'greenhouse', 'greenhouse-jumptrading', 'jump-trading', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-jump-trading', 'github', 'employer:jump-trading', 'jump-trading', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-jumptrading', 'github', 'employer:jumptrading', 'jump-trading', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-greenhouse-squarepointcapital', 'greenhouse', 'greenhouse-squarepointcapital', 'squarepoint-capital', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-squarepoint-capital', 'github', 'employer:squarepoint-capital', 'squarepoint-capital', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z'),
  ('issue-50-github-employer-squarepointcapital', 'github', 'employer:squarepointcapital', 'squarepoint-capital', '2026-08-30T00:00:00Z', 'issue-50-production-review', '2026-08-30T00:00:00Z')
ON CONFLICT(id) DO NOTHING;

-- Admission review decisions are append-only operational evidence. Later
-- changes must be expressed as new superseding records, never edits.
INSERT INTO migration_0011_reviewed_identity_assertion (ok)
SELECT 0 FROM admission_reviewer_decisions
WHERE id LIKE 'issue-50-%'
  AND id IN (
    'issue-50-canonical-aquatic-capital-management',
    'issue-50-canonical-jump-trading',
    'issue-50-canonical-squarepoint-capital',
    'issue-50-mapping-greenhouse-aquaticcapitalmanagement',
    'issue-50-mapping-github-employer-aquatic',
    'issue-50-mapping-github-employer-aquatic-capital',
    'issue-50-mapping-github-employer-aquatic-capital-management',
    'issue-50-mapping-greenhouse-jumptrading',
    'issue-50-mapping-github-employer-jump-trading',
    'issue-50-mapping-github-employer-jumptrading',
    'issue-50-mapping-greenhouse-squarepointcapital',
    'issue-50-mapping-github-employer-squarepoint-capital',
    'issue-50-mapping-github-employer-squarepointcapital'
  )
  AND NOT (
    subject_type = CASE WHEN id LIKE 'issue-50-canonical-%' THEN 'canonical-employer' ELSE 'employer-mapping' END
    AND subject_id = CASE WHEN id LIKE 'issue-50-canonical-%'
      THEN substr(id, length('issue-50-canonical-') + 1)
      ELSE 'issue-50-' || substr(id, length('issue-50-mapping-') + 1)
    END
    AND decision = 'approved'
    AND reason = CASE WHEN id LIKE 'issue-50-canonical-%'
      THEN 'Official employer materials reviewed for canonical identity and display name.'
      WHEN id LIKE 'issue-50-mapping-greenhouse-%'
      THEN 'Reviewed official Greenhouse source mapping.'
      ELSE 'Reviewed observed community employer scope.'
    END
    AND reviewed_at = '2026-08-30T00:00:00Z'
    AND reviewed_by = 'issue-50-production-review'
  );

CREATE TRIGGER IF NOT EXISTS admission_reviewer_decisions_no_update
BEFORE UPDATE ON admission_reviewer_decisions
BEGIN
  SELECT RAISE(ABORT, 'admission reviewer decisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS admission_reviewer_decisions_no_delete
BEFORE DELETE ON admission_reviewer_decisions
BEGIN
  SELECT RAISE(ABORT, 'admission reviewer decisions are immutable');
END;

INSERT OR IGNORE INTO admission_reviewer_decisions
  (id, subject_type, subject_id, decision, reason, reviewed_at, reviewed_by)
VALUES
  ('issue-50-canonical-aquatic-capital-management', 'canonical-employer', 'aquatic-capital-management', 'approved', 'Official employer materials reviewed for canonical identity and display name.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-canonical-jump-trading', 'canonical-employer', 'jump-trading', 'approved', 'Official employer materials reviewed for canonical identity and display name.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-canonical-squarepoint-capital', 'canonical-employer', 'squarepoint-capital', 'approved', 'Official employer materials reviewed for canonical identity and display name.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-greenhouse-aquaticcapitalmanagement', 'employer-mapping', 'issue-50-greenhouse-aquaticcapitalmanagement', 'approved', 'Reviewed official Greenhouse source mapping.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-aquatic', 'employer-mapping', 'issue-50-github-employer-aquatic', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-aquatic-capital', 'employer-mapping', 'issue-50-github-employer-aquatic-capital', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-aquatic-capital-management', 'employer-mapping', 'issue-50-github-employer-aquatic-capital-management', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-greenhouse-jumptrading', 'employer-mapping', 'issue-50-greenhouse-jumptrading', 'approved', 'Reviewed official Greenhouse source mapping.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-jump-trading', 'employer-mapping', 'issue-50-github-employer-jump-trading', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-jumptrading', 'employer-mapping', 'issue-50-github-employer-jumptrading', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-greenhouse-squarepointcapital', 'employer-mapping', 'issue-50-greenhouse-squarepointcapital', 'approved', 'Reviewed official Greenhouse source mapping.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-squarepoint-capital', 'employer-mapping', 'issue-50-github-employer-squarepoint-capital', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review'),
  ('issue-50-mapping-github-employer-squarepointcapital', 'employer-mapping', 'issue-50-github-employer-squarepointcapital', 'approved', 'Reviewed observed community employer scope.', '2026-08-30T00:00:00Z', 'issue-50-production-review');

DROP TABLE migration_0011_reviewed_identity_assertion;
