-- Issue #50 production review decisions. Official employer materials support
-- these canonical names:
--   https://aquatic.com/disclosures/index.html
--   https://www.jumptrading.com/
--   https://www.squarepoint-capital.com/about
-- Provider board tokens and community spellings remain evidence scopes; they
-- do not become canonical employer IDs themselves.
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
