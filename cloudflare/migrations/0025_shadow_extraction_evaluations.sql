CREATE TABLE shadow_extraction_evaluations (
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key),
  field TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('correct-present', 'correct-absent', 'false-positive', 'false-negative', 'wrong-value', 'wrong-status')),
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (run_key, field)
);

CREATE INDEX shadow_extraction_evaluations_outcome ON shadow_extraction_evaluations(field, outcome);
