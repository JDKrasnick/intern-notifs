CREATE TABLE employer_organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT NOT NULL COLLATE NOCASE UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, retain_until TEXT
);

CREATE TABLE employer_memberships (
  organization_id TEXT NOT NULL REFERENCES employer_organizations(id), user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX employer_memberships_user ON employer_memberships(user_id, organization_id);

CREATE TABLE employer_invitations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id),
  email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  accepted_at TEXT, revoked_at TEXT
);
CREATE INDEX employer_invitations_org ON employer_invitations(organization_id, created_at);

CREATE TABLE employer_verification_challenges (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id),
  method TEXT NOT NULL CHECK (method IN ('email-domain', 'dns-txt', 'well-known')),
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE (organization_id, id)
);
CREATE INDEX employer_challenges_expiry ON employer_verification_challenges(expires_at);

CREATE TABLE employer_verifications (
  organization_id TEXT PRIMARY KEY REFERENCES employer_organizations(id),
  state TEXT NOT NULL CHECK (state IN ('challenge-pending', 'review-pending', 'verified', 'rejected', 'expired', 'revoked')),
  challenge_id TEXT, reason TEXT, reviewed_by TEXT,
  updated_at TEXT NOT NULL, verified_at TEXT, expires_at TEXT,
  FOREIGN KEY (organization_id, challenge_id) REFERENCES employer_verification_challenges(organization_id, id)
);

CREATE TABLE employer_source_connections (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'json-ld', 'sitemap', 'embedded')),
  url TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending-review', 'shadow', 'active', 'stale', 'disconnected', 'quarantined', 'rejected')),
  reason TEXT, source_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (organization_id, url)
);
CREATE INDEX employer_sources_state ON employer_source_connections(state, updated_at);

CREATE TABLE reviewed_source_registry (
  source_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'json-ld', 'sitemap', 'embedded')),
  organization_id TEXT REFERENCES employer_organizations(id), config_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('shadow', 'active', 'quarantined', 'disabled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX reviewed_source_registry_dispatch ON reviewed_source_registry(provider, state, updated_at);

CREATE TABLE employer_field_proposals (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id), job_id TEXT NOT NULL,
  field TEXT NOT NULL, original_value TEXT, proposed_value TEXT NOT NULL, evidence_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending-review', 'accepted', 'rejected', 'withdrawn')),
  reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE INDEX employer_proposals_queue ON employer_field_proposals(state, created_at);

CREATE TABLE employer_submissions (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id),
  title TEXT NOT NULL, company TEXT NOT NULL, program_type TEXT NOT NULL, discipline TEXT NOT NULL,
  location TEXT NOT NULL, work_mode TEXT NOT NULL, season TEXT NOT NULL, application_url TEXT NOT NULL,
  deadline TEXT NOT NULL, deadline_timezone TEXT,
  work_authorization TEXT NOT NULL CHECK (work_authorization IN ('sponsorship-available', 'no-sponsorship', 'existing-authorization-required', 'citizenship-required', 'unknown')),
  compensation TEXT, graduation_window TEXT, private_review_note TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'pending-review', 'published', 'rejected', 'quarantined', 'closed')),
  reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  published_at TEXT, closed_at TEXT,
  UNIQUE (organization_id, id)
);
CREATE INDEX employer_submissions_org ON employer_submissions(organization_id, updated_at);
CREATE INDEX employer_submissions_queue ON employer_submissions(state, updated_at);

CREATE TABLE employer_reports (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id),
  submission_id TEXT, reporter_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('identity', 'destination', 'closed-role', 'misleading-metadata', 'other')),
  details TEXT, state TEXT NOT NULL CHECK (state IN ('open', 'upheld', 'dismissed')),
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT,
  FOREIGN KEY (organization_id, submission_id) REFERENCES employer_submissions(organization_id, id)
);
CREATE INDEX employer_reports_queue ON employer_reports(state, created_at);

CREATE TABLE employer_publishing_privileges (
  organization_id TEXT PRIMARY KEY REFERENCES employer_organizations(id), automatic_publishing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_publishing_enabled IN (0, 1)),
  enabled_at TEXT, enabled_by TEXT, suspended_at TEXT, suspension_reason TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE employer_idempotency_keys (
  organization_id TEXT NOT NULL REFERENCES employer_organizations(id), operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (organization_id, operation, idempotency_key)
);

CREATE TABLE employer_audit_events (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES employer_organizations(id), action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('member', 'reviewer', 'system')), actor_id TEXT,
  subject_type TEXT NOT NULL, subject_id TEXT, details TEXT, created_at TEXT NOT NULL, idempotency_key TEXT,
  UNIQUE (organization_id, action, idempotency_key)
);
CREATE INDEX employer_audit_org ON employer_audit_events(organization_id, created_at, id);

CREATE TRIGGER employer_audit_no_update BEFORE UPDATE ON employer_audit_events
BEGIN SELECT RAISE(ABORT, 'employer audit events are immutable'); END;
CREATE TRIGGER employer_audit_no_delete BEFORE DELETE ON employer_audit_events
BEGIN SELECT RAISE(ABORT, 'employer audit events are immutable'); END;
