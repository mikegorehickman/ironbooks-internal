-- Migration 153 — put Small Tools back at top level (reverts part of 152)
--
-- MY ERROR, not a new decision. Migration 152 treated "Job Supplies & Materials"
-- and "Small Tools" as accidental orphans and re-parented them under the Job
-- Costs headers. They were never orphans:
--
--   Migration 129 (2026-07-15) — Mike, reviewing Dominion Painters' P&L:
--     "Job Supplies & Materials should not be a sub-account of COGS. Parent
--      'Materials & Supplies' should be just cost of goods — remove the
--      sub-account."
--   That migration lifted BOTH accounts to top-level Cost of Goods Sold and
--   deleted the "Job Costs - Materials & Supplies" parent header.
--
-- So 152's re-parent contradicted a decision already made. Job Supplies &
-- Materials survived by luck — 152 guarded on the parent existing, and 129 had
-- deleted it. Small Tools had no such luck: 'Job Costs - Other' still exists, so
-- 152 moved it (2 rows, CA + US). This puts it back.
--
-- Restores exactly what 129 set: top-level, Cost of Goods Sold /
-- SuppliesMaterialsCogs, not a parent.
--
-- Lesson worth keeping: a parentless leaf in this chart is not automatically a
-- defect. Revenue is a flat list, balance-sheet accounts aren't grouped, QBO
-- system accounts must stay put, and some COGS accounts are top-level BY
-- DECISION. Check the migration history before "fixing" a structure.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

UPDATE master_coa
SET parent_account_name = NULL,
    is_parent = false,
    qbo_account_type = 'Cost of Goods Sold',
    qbo_account_subtype = 'SuppliesMaterialsCogs',
    updated_at = now()
WHERE account_name = 'Small Tools'
  AND section = 'cogs'
  AND parent_account_name IS NOT NULL;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- One result set (the editor only shows the last query).
SELECT * FROM (
  -- 1) Both job-cost accounts should now read parent = "(top level)" again.
  SELECT 1 AS ord,
         jurisdiction || ' · ' || account_name AS item,
         coalesce(parent_account_name, '(top level)') || ' · ' || qbo_account_type AS value
    FROM master_coa
   WHERE account_name IN ('Job Supplies & Materials', 'Small Tools')

  UNION ALL
  -- 2) Nothing should be left pointing at the header 129 deleted.
  SELECT 2, 'rows still parented to the deleted Materials & Supplies header',
         count(*)::text
    FROM master_coa
   WHERE parent_account_name = 'Job Costs - Materials & Supplies'

  UNION ALL
  -- 3) What's genuinely left to decide. Expected: Licenses, Penalties & Fines,
  --    Taxes. (Depreciation and Uncategorized Expenses belong at top level, and
  --    so do the two above — this list is informational, not a to-do.)
  SELECT 3, 'parentless expense/COGS leaves (incl. intentional ones)',
         coalesce(string_agg(DISTINCT account_name, ', '), 'none')
    FROM master_coa
   WHERE parent_account_name IS NULL AND is_parent = false
     AND section IN ('cogs', 'operating_expense')

  UNION ALL
  -- 4) The other open question from 152: no client_month is 'complete' and none
  --    carries month_end_sent_at, so nothing was backfillable. This shows how
  --    the 72 months are actually distributed, to confirm they're genuinely open
  --    rather than closed via some other signal.
  SELECT 4, 'client_months by status', string_agg(s.status || '=' || s.n, ', ' ORDER BY s.n DESC)
    FROM (SELECT coalesce(status, 'null') AS status, count(*)::text AS n
            FROM client_months GROUP BY coalesce(status, 'null')) s
) v ORDER BY ord, item;
