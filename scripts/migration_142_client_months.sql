-- Migration 142 — client_months: the monthly close bucket
--
-- SNAP has had a production board and a reclass tool, but no concept of "a
-- client's month". A reclass job carries a free-typed date range, so nothing in
-- the system can answer "is June done for this client?" — the board shows a
-- generic status and the bookkeeper holds the month in their head.
--
-- This table makes the month the unit of work. One row per client per month,
-- created on the 1st (or opened manually for a catch-up month), carrying one
-- timestamp per stage of the close. A NULL stage timestamp means "not done" —
-- so progress is derivable, not asserted, and a half-finished month can never
-- look complete.
--
-- Stage order mirrors the agreed workflow:
--   COA confirm → reclass → bank rules → UF/AR (+ statement request)
--   → duplicate payroll → duplicate transactions → close → send statements
--
-- Deliberately NOT a status enum per stage. A timestamp answers "when", which is
-- what a month-end review actually needs, and it removes the class of bug where
-- a status says done while the underlying work isn't.

BEGIN;

CREATE TABLE IF NOT EXISTS client_months (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id           UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,

  -- Always the FIRST day of the month (2026-06-01). Enforced below so callers
  -- can't half-populate it with random days and break grouping.
  period_month             DATE NOT NULL,

  -- Board lane. Derived state lives in the stage timestamps; this is the
  -- human/workflow overlay (who's blocked, who's waiting on a client).
  status                   TEXT NOT NULL DEFAULT 'not_started'
                             CHECK (status IN ('not_started','in_progress','waiting_client',
                                               'ready_for_review','failed_review','complete')),
  assignee_id              UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- ── Stage completion. NULL = not done. ────────────────────────────────────
  coa_confirmed_at         TIMESTAMPTZ,   -- chart matches current master COA
  reclass_completed_at     TIMESTAMPTZ,
  bank_rules_completed_at  TIMESTAMPTZ,
  uf_ar_completed_at       TIMESTAMPTZ,
  statements_requested_at  TIMESTAMPTZ,   -- request sent to the client
  payroll_dup_checked_at   TIMESTAMPTZ,
  txn_dup_checked_at       TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,   -- books closed for the month
  statements_sent_at       TIMESTAMPTZ,   -- statements published/emailed

  -- Provenance so a stage tick is auditable back to the job that earned it.
  reclass_job_id           UUID,
  coa_job_id               UUID,

  blocked_reason           TEXT,
  notes                    TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One bucket per client per month. This is what makes "open June" idempotent:
  -- re-running the opener can never double-create.
  CONSTRAINT client_months_unique UNIQUE (client_link_id, period_month),
  CONSTRAINT client_months_first_of_month CHECK (date_trunc('month', period_month) = period_month)
);

CREATE INDEX IF NOT EXISTS idx_client_months_period ON client_months(period_month DESC);
CREATE INDEX IF NOT EXISTS idx_client_months_status ON client_months(status);
CREATE INDEX IF NOT EXISTS idx_client_months_client ON client_months(client_link_id, period_month DESC);

COMMENT ON TABLE client_months IS
  'One row per client per month — the unit of monthly close work. Stage columns '
  'are completion timestamps (NULL = not done) so progress is derived rather '
  'than asserted; a half-finished month cannot report complete.';
COMMENT ON COLUMN client_months.period_month IS
  'First day of the month the work covers (2026-06-01 = June 2026).';

-- updated_at maintenance (matches the pattern used elsewhere in this schema).
CREATE OR REPLACE FUNCTION set_client_months_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_months_updated_at ON client_months;
CREATE TRIGGER trg_client_months_updated_at
  BEFORE UPDATE ON client_months
  FOR EACH ROW EXECUTE FUNCTION set_client_months_updated_at();

COMMIT;

-- ── OPEN A MONTH ────────────────────────────────────────────────────────────
-- Idempotent, thanks to the unique constraint. Run this to open June for every
-- live production client so the team can start the catch-up immediately rather
-- than waiting for the 1st-of-month cron.
--
-- Eligibility mirrors "a client whose books we actually run": active, and either
-- signed off on cleanup or on the daily engine. Onboarding clients are excluded
-- — they have no month to close yet.
--
--   INSERT INTO client_months (client_link_id, period_month)
--   SELECT id, DATE '2026-06-01'
--   FROM client_links
--   WHERE is_active = true
--     AND (cleanup_completed_at IS NOT NULL OR daily_recon_enabled = true)
--   ON CONFLICT (client_link_id, period_month) DO NOTHING;
--
-- Then July, when you're ready:
--
--   INSERT INTO client_months (client_link_id, period_month)
--   SELECT id, DATE '2026-07-01'
--   FROM client_links
--   WHERE is_active = true
--     AND (cleanup_completed_at IS NOT NULL OR daily_recon_enabled = true)
--   ON CONFLICT (client_link_id, period_month) DO NOTHING;
--
-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT period_month, status, count(*)
--   FROM client_months GROUP BY 1,2 ORDER BY 1 DESC, 2;
