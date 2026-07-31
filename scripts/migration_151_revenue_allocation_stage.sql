-- Migration 151 — revenue allocation as the FIRST monthly-close stage
--
-- The close board ran COA → reclass → bank rules → … with no revenue step, so a
-- month could be worked end to end while deposits that belong against invoices
-- were still sitting in income. Everything downstream is then judged against a
-- revenue figure that is about to move: COGS %, net margin, the red-flag
-- approval gate, and (now) a client's time budget. Allocating revenue FIRST
-- means the rest of the close is done once instead of twice.
--
-- Stage completion is a TIMESTAMP, never a status string — same rule as every
-- other stage (see lib/client-months.ts): a timestamp answers "when", and it
-- removes the class of bug where a status claims done while the work isn't.
-- Skippable, because a deposits-only client with no invoicing has nothing to
-- allocate; skips are recorded in the existing skipped_stages/skip_reasons
-- columns from migration 143.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

ALTER TABLE client_months ADD COLUMN IF NOT EXISTS revenue_allocated_at timestamptz;

COMMENT ON COLUMN client_months.revenue_allocated_at IS
  'Stage 1 of the monthly close: deposits matched to invoices / revenue allocation confirmed. NULL = not done. Skippable for deposits-only clients. See MONTH_STAGES in lib/client-months.ts. Migration 151.';

-- Months already CLOSED before this stage existed shouldn't reopen as
-- incomplete. Backfill them as done, stamped with when the month was sent, so
-- history reads truthfully rather than showing a gap nobody can action.
UPDATE client_months
SET revenue_allocated_at = coalesce(month_end_sent_at, updated_at, now())
WHERE revenue_allocated_at IS NULL
  AND month_end_sent_at IS NOT NULL;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
SELECT 'migration_151 applied' AS status,
       count(*) FILTER (WHERE revenue_allocated_at IS NOT NULL) AS allocated,
       count(*) FILTER (WHERE revenue_allocated_at IS NULL)     AS pending,
       count(*) AS total_client_months
FROM client_months;
