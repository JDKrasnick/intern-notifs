-- Human review concerns one posting. Unrelated collection must not expire it.
-- Catalog-wide repair revision guards from 0018 remain unchanged.
CREATE TABLE role_metadata_job_revision (job_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
ALTER TABLE role_metadata_review_plans ADD COLUMN job_revision INTEGER NOT NULL DEFAULT -1;
CREATE TRIGGER metadata_job_evidence_insert AFTER INSERT ON role_metadata_evidence
BEGIN
  INSERT INTO role_metadata_job_revision VALUES (NEW.job_id, 1)
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER metadata_job_evidence_update AFTER UPDATE ON role_metadata_evidence
BEGIN
  INSERT INTO role_metadata_job_revision VALUES (OLD.job_id, 1)
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO role_metadata_job_revision SELECT NEW.job_id, 1 WHERE NEW.job_id != OLD.job_id
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER metadata_job_evidence_delete AFTER DELETE ON role_metadata_evidence
BEGIN
  INSERT INTO role_metadata_job_revision VALUES (OLD.job_id, 1)
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER metadata_job_catalog_insert AFTER INSERT ON catalog_items WHEN NEW.kind = 'internship'
BEGIN
  INSERT INTO role_metadata_job_revision VALUES (substr(NEW.pk, 5), 1)
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER metadata_job_catalog_update AFTER UPDATE ON catalog_items WHEN NEW.kind = 'internship' OR OLD.kind = 'internship'
BEGIN
  INSERT INTO role_metadata_job_revision VALUES (substr(OLD.pk, 5), 1)
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO role_metadata_job_revision SELECT substr(NEW.pk, 5), 1 WHERE NEW.pk != OLD.pk
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER metadata_job_catalog_delete AFTER DELETE ON catalog_items WHEN OLD.kind = 'internship'
BEGIN
  INSERT INTO role_metadata_job_revision VALUES (substr(OLD.pk, 5), 1)
  ON CONFLICT(job_id) DO UPDATE SET revision = revision + 1;
END;
