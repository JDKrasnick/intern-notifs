-- A review authorizes omission, never a replacement amount or public write.
CREATE TABLE role_metadata_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
INSERT INTO role_metadata_revision VALUES (1, 0);
CREATE TABLE role_metadata_review_plans (
  token TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  original_value TEXT NOT NULL,
  decision TEXT NOT NULL,
  metadata_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE TABLE role_metadata_review_decisions (
  job_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  decision TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE TABLE role_metadata_review_guards (
  token TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1),
  approved_at TEXT NOT NULL
);
ALTER TABLE role_metadata_repair_plans ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT -1;
CREATE TABLE role_metadata_repair_review_stage (
  token TEXT NOT NULL,
  job_id TEXT NOT NULL,
  decision_token TEXT NOT NULL,
  PRIMARY KEY(token, job_id)
);
CREATE TRIGGER role_metadata_evidence_revision_insert AFTER INSERT ON role_metadata_evidence
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_evidence_revision_update AFTER UPDATE ON role_metadata_evidence
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_evidence_revision_delete AFTER DELETE ON role_metadata_evidence
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_extraction_attempts_revision_insert AFTER INSERT ON role_metadata_extraction_attempts
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_extraction_attempts_revision_update AFTER UPDATE ON role_metadata_extraction_attempts
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_extraction_attempts_revision_delete AFTER DELETE ON role_metadata_extraction_attempts
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_review_decisions_revision_insert AFTER INSERT ON role_metadata_review_decisions
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_review_decisions_revision_update AFTER UPDATE ON role_metadata_review_decisions
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_review_decisions_revision_delete AFTER DELETE ON role_metadata_review_decisions
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_conflicts_revision_insert AFTER INSERT ON role_metadata_conflicts
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_conflicts_revision_update AFTER UPDATE ON role_metadata_conflicts
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER role_metadata_conflicts_revision_delete AFTER DELETE ON role_metadata_conflicts
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
-- Catalog mutations can change the collection cohort or evidence references.
-- Include them in the same atomic precondition, including outside-batch roles.
CREATE TRIGGER catalog_metadata_revision_insert AFTER INSERT ON catalog_items WHEN NEW.kind = 'internship'
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_metadata_revision_update AFTER UPDATE ON catalog_items WHEN NEW.kind = 'internship' OR OLD.kind = 'internship'
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_metadata_revision_delete AFTER DELETE ON catalog_items WHEN OLD.kind = 'internship'
BEGIN UPDATE role_metadata_revision SET revision = revision + 1 WHERE id = 1; END;
