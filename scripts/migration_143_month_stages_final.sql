-- Migration 143 — reshape client_months to the agreed 7-stage close, and make
-- "skipped" a real state distinct from "done".
--
-- Migration 142 guessed at 8 stages. The agreed list is 7:
--
--   1. Confirm COA adherence   (skippable)
--   2. Transaction reclass
--   3. New bank rules application
--   4. Ask client
--   5. BS / statement request
--   6. Duplicate transactions and invoices
--   7. Send month-end to client
--
-- WHY skipped ≠ done: "we checked the chart and it's fine" and "this client
-- doesn't need a chart check this month" are different facts, and a month-end
-- reviewer needs to tell them apart. Collapsing skip into done is how a checklist
-- turns into theatre. Stored as an array rather than seven more nullable columns
-- so adding a stage later stays a one-line change.
--
-- Safe to run: the table holds only freshly-opened, all-NULL buckets, so no stage
-- data is lost by dropping the columns that didn't survive the reshape.

BEGIN;

-- ── New stages ──────────────────────────────────────────────────────────────
ALTER TABLE client_months
  ADD COLUMN IF NOT EXISTS ask_client_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duplicates_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS month_end_sent_at     TIMESTAMPTZ;

-- Carry over anything already recorded under the old names before dropping them.
UPDATE client_months
SET month_end_sent_at     = COALESCE(month_end_sent_at, statements_sent_at),
    duplicates_checked_at = COALESCE(duplicates_checked_at, txn_dup_checked_at, payroll_dup_checked_at)
WHERE statements_sent_at IS NOT NULL
   OR txn_dup_checked_at IS NOT NULL
   OR payroll_dup_checked_at IS NOT NULL;

ALTER TABLE client_months
  DROP COLUMN IF EXISTS uf_ar_completed_at,
  DROP COLUMN IF EXISTS payroll_dup_checked_at,
  DROP COLUMN IF EXISTS txn_dup_checked_at,
  DROP COLUMN IF EXISTS statements_sent_at,
  DROP COLUMN IF EXISTS closed_at;

-- ── Skip support ────────────────────────────────────────────────────────────
-- A stage key present here is deliberately not-applicable this month. Paired
-- with skip_reasons so "why" survives the month.
ALTER TABLE client_months
  ADD COLUMN IF NOT EXISTS skipped_stages TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS skip_reasons   JSONB  NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN client_months.skipped_stages IS
  'Stage keys deliberately skipped this month. A skipped stage does not block the '
  'close but is NOT counted as done — "checked and fine" and "not applicable" are '
  'different facts and a reviewer must be able to tell them apart.';
COMMENT ON COLUMN client_months.skip_reasons IS
  'Stage key → free-text reason, so a skip is auditable after the month closes.';

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'client_months'
--   ORDER BY ordinal_position;
--
-- Expect these 7 stage columns and nothing else stage-shaped:
--   coa_confirmed_at, reclass_completed_at, bank_rules_completed_at,
--   ask_client_at, statements_requested_at, duplicates_checked_at,
--   month_end_sent_at
