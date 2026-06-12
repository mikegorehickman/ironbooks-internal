-- Migration 64: Monthly Rec two-stage approval + AI spot check
-- =============================================================
-- JR bookkeeper reviews P&L/BS/CFS + AI spot check, attests, and SUBMITS.
-- The run goes to pending_review — surfaced on /today for admin/lead, who
-- review the same statements and approve & send (email + portal + close).
-- Seniors closing their own clients can still send directly.
--
-- kind distinguishes the two close buttons:
--   production_me — Monthly Rec monthly close
--   cleanup       — statement sign-off when a cleanup is completed
--
-- Idempotent — safe to run more than once.

ALTER TABLE monthly_rec_runs
  ADD COLUMN IF NOT EXISTS kind          text NOT NULL DEFAULT 'production_me',
  ADD COLUMN IF NOT EXISTS ai_spot_check jsonb,
  ADD COLUMN IF NOT EXISTS submitted_by  uuid,
  ADD COLUMN IF NOT EXISTS submitted_at  timestamptz;

ALTER TABLE monthly_rec_runs
  DROP CONSTRAINT IF EXISTS monthly_rec_runs_status_check;
ALTER TABLE monthly_rec_runs
  ADD CONSTRAINT monthly_rec_runs_status_check
  CHECK (status IN ('open', 'pending_review', 'complete'));

ALTER TABLE monthly_rec_runs
  DROP CONSTRAINT IF EXISTS monthly_rec_runs_kind_check;
ALTER TABLE monthly_rec_runs
  ADD CONSTRAINT monthly_rec_runs_kind_check
  CHECK (kind IN ('production_me', 'cleanup'));

CREATE INDEX IF NOT EXISTS idx_monthly_rec_runs_pending
  ON monthly_rec_runs (status) WHERE status = 'pending_review';
