-- Reviewed during the issue #120 production audit. Provider board labels stay
-- separate from these canonical employer identities.
INSERT OR IGNORE INTO canonical_employers
  (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
VALUES
  ('artefact', 'Artefact', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('astera-labs', 'Astera Labs', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('axon', 'Axon', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('chicago-trading-company', 'Chicago Trading Company', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('five-rings', 'Five Rings', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('optiver', 'Optiver', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('radix-trading', 'Radix Trading', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('tenstorrent', 'Tenstorrent', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('toshiba-global-commerce-solutions', 'Toshiba Global Commerce Solutions', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z'),
  ('virtu-financial', 'Virtu Financial', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');

INSERT OR IGNORE INTO employer_mappings
  (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
VALUES
  ('issue-120-greenhouse-artefactlinkedin', 'greenhouse', 'greenhouse-artefactlinkedin', 'artefact', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-asteraearlycareer2026', 'greenhouse', 'greenhouse-asteraearlycareer2026', 'astera-labs', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-axontalentcommunity', 'greenhouse', 'greenhouse-axontalentcommunity', 'axon', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-ctccampusboard', 'greenhouse', 'greenhouse-ctccampusboard', 'chicago-trading-company', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-fiveringsllc', 'greenhouse', 'greenhouse-fiveringsllc', 'five-rings', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-optiverprivate', 'greenhouse', 'greenhouse-optiverprivate', 'optiver', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-radixuniversity', 'greenhouse', 'greenhouse-radixuniversity', 'radix-trading', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-tenstorrentuniversity', 'greenhouse', 'greenhouse-tenstorrentuniversity', 'tenstorrent', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-toshibaglobalcommercesolutions', 'greenhouse', 'greenhouse-toshibaglobalcommercesolutions', 'toshiba-global-commerce-solutions', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-virturecruitinghidden', 'greenhouse', 'greenhouse-virturecruitinghidden', 'virtu-financial', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-artefact', 'greenhouse', 'employer:artefact', 'artefact', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-astera-labs', 'greenhouse', 'employer:astera-labs', 'astera-labs', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-axon', 'greenhouse', 'employer:axon', 'axon', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-chicago-trading-company', 'greenhouse', 'employer:chicago-trading-company', 'chicago-trading-company', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-five-rings', 'greenhouse', 'employer:five-rings', 'five-rings', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-optiver', 'greenhouse', 'employer:optiver', 'optiver', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-radix-trading', 'greenhouse', 'employer:radix-trading', 'radix-trading', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-tenstorrent', 'greenhouse', 'employer:tenstorrent', 'tenstorrent', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-toshiba-global-commerce-solutions', 'greenhouse', 'employer:toshiba-global-commerce-solutions', 'toshiba-global-commerce-solutions', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z'),
  ('issue-120-greenhouse-employer-virtu-financial', 'greenhouse', 'employer:virtu-financial', 'virtu-financial', '2026-08-28T00:00:00Z', 'issue-120-production-audit', '2026-08-28T00:00:00Z');

-- Host decisions come from rendered representative samples. Aggregate rules
-- fail every posting closed; browser-required rules still require per-posting
-- rendered proof and therefore do not turn a sampled success into a host-wide pass.
WITH reviewed(id, host, decision) AS (VALUES
  ('issue-120-zipline', 'www.zipline.com', 'aggregate-board'),
  ('issue-120-squarepoint', 'www.squarepoint-capital.com', 'aggregate-board'),
  ('issue-120-tower-research', 'www.tower-research.com', 'aggregate-board'),
  ('issue-120-nextiva', 'www.nextiva.com', 'aggregate-board'),
  ('issue-120-pathai', 'www.pathai.com', 'aggregate-board'),
  ('issue-120-jump', 'www.jumptrading.com', 'browser-required'),
  ('issue-120-aqr', 'careers.aqr.com', 'browser-required'),
  ('issue-120-workato', 'www.workato.com', 'browser-required'),
  ('issue-120-verition', 'www.verition.com', 'browser-required'),
  ('issue-120-hrt', 'www.hudsonrivertrading.com', 'browser-required'),
  ('issue-120-old-mission', 'www.oldmissioncapital.com', 'browser-required'),
  ('issue-120-ast-spacemobile', 'ast-science.com', 'browser-required'),
  ('issue-120-alayacare', 'alayacare.com', 'browser-required'),
  ('issue-120-artisan-partners', 'www.artisanpartners.com', 'browser-required'),
  ('issue-120-stoke-space', 'www.stokespace.com', 'browser-required')
)
INSERT INTO destination_review_rules (id, host, provider, tenant, decision, reviewed_at, reviewed_by)
SELECT id, host, 'greenhouse', NULL, decision, '2026-08-28T00:00:00Z', 'issue-120-browser-audit'
FROM reviewed
WHERE NOT EXISTS (
  SELECT 1 FROM destination_review_rules AS current
  WHERE current.host = reviewed.host AND current.provider = 'greenhouse' AND current.tenant IS NULL
);
