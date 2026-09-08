-- Exact employer-owned pages resolve presentation conflicts only after a
-- reviewer records the fields shown by the official posting. These decisions
-- are immutable and scoped to one provider tenant and posting ID.
CREATE TABLE posting_identity_presentation_reviews (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tenant TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  locations_json TEXT NOT NULL CHECK (json_valid(locations_json)),
  apply_url TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  UNIQUE (provider, tenant, posting_id)
);

CREATE TRIGGER posting_identity_presentation_reviews_no_update
BEFORE UPDATE ON posting_identity_presentation_reviews
BEGIN
  SELECT RAISE(ABORT, 'posting identity presentation reviews are immutable');
END;

CREATE TRIGGER posting_identity_presentation_reviews_no_delete
BEFORE DELETE ON posting_identity_presentation_reviews
BEGIN
  SELECT RAISE(ABORT, 'posting identity presentation reviews are immutable');
END;

INSERT INTO posting_identity_presentation_reviews
  (id, provider, tenant, posting_id, company, title, location, locations_json,
   apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by)
VALUES
  (
    'pr155-meta-1027438186737957',
    'meta',
    'meta',
    '1027438186737957',
    'Meta',
    'Research Scientist Intern, AI, Cyber Security, Safety — MSL Trust & Safety (PhD)',
    'Menlo Park, CA',
    '["Menlo Park, CA"]',
    'https://www.metacareers.com/jobs/1027438186737957',
    'https://www.metacareers.com/profile/job_details/1027438186737957/',
    '84f373b8ed7792a0560a4904a784062e3b933b0a35d880f3244f08e0075c657f',
    '2026-09-04T15:40:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr155-goldman-sachs-171567',
    'goldman-sachs',
    'goldman-sachs',
    '171567',
    'Goldman Sachs',
    '2027 | Americas | Toronto | Engineering | Summer Analyst',
    'Toronto, ON, Canada',
    '["Toronto, ON, Canada"]',
    'https://higher.gs.com/roles/171567',
    'https://higher.gs.com/roles/171567',
    '340d2c8b1a8ebe3257a893c078641020eff6fa258902ffba8d090db1634ff264',
    '2026-09-04T15:40:00Z',
    'owner-directed-official-page-review'
  );
