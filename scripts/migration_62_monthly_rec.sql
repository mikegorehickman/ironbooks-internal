-- Migration 62: Monthly Rec runs
-- ===============================
-- One row per (client, month) for the Monthly Rec workflow: production
-- clients (daily_recon_enabled) get a <5-minute monthly catch-up — run
-- automated checks (uncategorized txns, UF balance, overdue A/R, negative
-- bank balances), fix via deep links, note concerns, mark the month done.
--
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS monthly_rec_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  period          text NOT NULL,              -- 'YYYY-MM'
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'complete')),
  checks          jsonb,                      -- snapshot of the last check run
  checks_ran_at   timestamptz,
  concerns        text,                       -- bookkeeper notes / flags
  has_concerns    boolean NOT NULL DEFAULT false,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_by    uuid,
  completed_at    timestamptz,
  UNIQUE (client_link_id, period)
);

CREATE INDEX IF NOT EXISTS idx_monthly_rec_runs_period
  ON monthly_rec_runs (period);
CREATE INDEX IF NOT EXISTS idx_monthly_rec_runs_client
  ON monthly_rec_runs (client_link_id);
