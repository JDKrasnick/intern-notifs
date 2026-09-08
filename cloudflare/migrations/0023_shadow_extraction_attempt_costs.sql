-- Reservations belong to inference attempts, not posting runs. Rebuilding this
-- pre-pilot table preserves any staging rows while allowing a retry or reclaimed
-- lease to reserve and reconcile its own cost independently.
ALTER TABLE shadow_extraction_cost_ledger RENAME TO shadow_extraction_cost_ledger_legacy;

CREATE TABLE shadow_extraction_cost_ledger (
  period TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key) ON DELETE CASCADE,
  reserved_cents INTEGER NOT NULL CHECK(reserved_cents > 0),
  actual_cents INTEGER NOT NULL DEFAULT 0 CHECK(actual_cents >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved', 'reconciled', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(period, lease_token)
);

INSERT INTO shadow_extraction_cost_ledger
  (period, lease_token, run_key, reserved_cents, actual_cents, state, created_at, updated_at)
SELECT legacy.period,
  COALESCE(NULLIF(runs.lease_token, ''), 'legacy:' || legacy.run_key),
  legacy.run_key, legacy.reserved_cents, legacy.actual_cents, legacy.state,
  legacy.created_at, legacy.updated_at
FROM shadow_extraction_cost_ledger_legacy AS legacy
LEFT JOIN shadow_extraction_runs AS runs ON runs.run_key = legacy.run_key;

DROP TABLE shadow_extraction_cost_ledger_legacy;

CREATE INDEX shadow_extraction_cost_ledger_run ON shadow_extraction_cost_ledger(period, run_key);
