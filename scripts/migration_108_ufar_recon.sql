-- migration 108 — UF/AR Reconciler runs.
-- One row per run of the one-button UF + A/R reconciliation: pulls UF ledger,
-- open A/R, bank deposits, and revenue straight from QBO, matches
-- deterministically, has Claude reconcile the remainder, and stores the
-- step-by-step clearing plan (Lisa's CSV → Claude-chat workflow, automated).
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS ufar_recon_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  error_message  text,
  window_days    int,
  summary        jsonb,      -- { uf_balance, booked_ar, true_ar, unmatched_deposits, ... }
  report         jsonb,      -- { ar_explained, steps: [...], matches: [...] }
  steps_done     jsonb NOT NULL DEFAULT '[]',  -- indexes of completed steps
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ufar_recon_client
  ON ufar_recon_runs (client_link_id, created_at DESC);
