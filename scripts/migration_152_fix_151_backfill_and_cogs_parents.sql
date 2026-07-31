-- Migration 152 — fix migration 151's backfill + parent two COGS orphans
--
-- ── 1. Migration 151's backfill matched NOTHING (allocated 0 / pending 72) ──
--
-- 151 backfilled closed months using `month_end_sent_at IS NOT NULL`. That
-- column is a close-board STAGE stamp and is null on all 72 client_months rows —
-- the board's real "this month is finished" marker is `status = 'complete'`. So
-- every historical month, closed or not, now shows an unfinished stage 1 that
-- nobody can action.
--
-- And the fix isn't to stamp revenue_allocated_at on them either: a timestamp
-- claims "this work happened at this time", and for a month closed before the
-- stage existed that would be a lie sitting in the record. Migration 143 already
-- gave us the honest answer — mark it SKIPPED with a reason. Skipped resolves the
-- stage without pretending anyone did it, which is exactly the situation.
--
-- ── 2. Two genuine COGS orphans from 150's verify output ────────────────────
--
-- 150's orphan check surfaced 22 parentless leaves. Most are correctly
-- top-level and left alone:
--   • revenue accounts (Service Revenue, Remodeling Revenue, Discounts) — the
--     revenue section has no parents by design, it's a flat list
--   • CA balance-sheet accounts (GST/HST Payable, GST/HST Recoverable, PST
--     Payable) — assets/liabilities aren't grouped in this chart
--   • Uncategorized Expenses — a QBO system account, must stay where QBO puts it
--   • Depreciation — a non-cash charge, conventionally its own statement line
-- (150's query was too broad: it only excluded section 'equity', so it flagged
-- all of those. Narrowed at the bottom of this file to expense/COGS leaves,
-- which are the only sections with parents to belong to.)
--
-- ⚠ SECTION 2 BELOW WAS WRONG — SEE MIGRATION 153, WHICH REVERTS IT.
-- Job Supplies & Materials and Small Tools are top-level Cost of Goods Sold BY
-- DECISION: migration 129 (2026-07-15) lifted them out of the Job Costs headers
-- at Mike's explicit request and deleted the Materials & Supplies parent. They
-- were never orphans. The Job Supplies & Materials update below no-opped only
-- because its guard found the parent already deleted; the Small Tools one
-- applied and had to be undone.
--
-- Original (mistaken) reasoning kept for the record: Job Supplies & Materials
-- and Small Tools are job costs sitting outside the Job Costs grouping, so COGS
-- subtotals on every statement exclude them. Taxes / Licenses / Penalties & Fines are left for Mike — where those
-- belong is his call, not a guess I should bake into 78 client charts.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

BEGIN;

-- ── 1. Resolve stage 1 on months that were already closed ───────────────────
UPDATE client_months
SET skipped_stages = array_append(coalesce(skipped_stages, '{}'), 'revenue_allocated_at'),
    skip_reasons = coalesce(skip_reasons, '{}'::jsonb)
      || jsonb_build_object('revenue_allocated_at',
                            'Month was closed before revenue allocation became a stage (migration 151)'),
    updated_at = now()
WHERE status = 'complete'
  AND revenue_allocated_at IS NULL
  AND NOT ('revenue_allocated_at' = ANY(coalesce(skipped_stages, '{}')));

-- Belt and braces: if any month DOES carry a month_end_sent_at (151's original
-- condition), treat it as closed too.
UPDATE client_months
SET skipped_stages = array_append(coalesce(skipped_stages, '{}'), 'revenue_allocated_at'),
    skip_reasons = coalesce(skip_reasons, '{}'::jsonb)
      || jsonb_build_object('revenue_allocated_at',
                            'Month was closed before revenue allocation became a stage (migration 151)'),
    updated_at = now()
WHERE month_end_sent_at IS NOT NULL
  AND revenue_allocated_at IS NULL
  AND NOT ('revenue_allocated_at' = ANY(coalesce(skipped_stages, '{}')));

-- 151 stamped revenue_allocated_at on nothing, but if a re-run ever did, undo
-- that claim in favour of the honest skip above.
UPDATE client_months
SET revenue_allocated_at = NULL, updated_at = now()
WHERE status = 'complete'
  AND revenue_allocated_at IS NOT NULL
  AND 'revenue_allocated_at' = ANY(coalesce(skipped_stages, '{}'));

-- ── 2. Job costs belong under the Job Costs grouping ───────────────────────
UPDATE master_coa
SET parent_account_name = 'Job Costs - Materials & Supplies', updated_at = now()
WHERE account_name = 'Job Supplies & Materials'
  AND section = 'cogs'
  AND parent_account_name IS NULL
  AND EXISTS (SELECT 1 FROM master_coa p
              WHERE p.account_name = 'Job Costs - Materials & Supplies' AND p.is_parent = true);

-- Small Tools: consumable job spend rather than materials that go into the job,
-- so "Other" rather than "Materials & Supplies".
UPDATE master_coa
SET parent_account_name = 'Job Costs - Other', updated_at = now()
WHERE account_name = 'Small Tools'
  AND section = 'cogs'
  AND parent_account_name IS NULL
  AND EXISTS (SELECT 1 FROM master_coa p
              WHERE p.account_name = 'Job Costs - Other' AND p.is_parent = true);

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- One result set on purpose: the Supabase editor only shows the LAST query's
-- output, so three separate SELECTs would hide the two that matter most.
SELECT * FROM (
  SELECT 1 AS ord,
         'stage 1 — allocated (real work logged)' AS check,
         count(*)::text AS value
    FROM client_months WHERE revenue_allocated_at IS NOT NULL
  UNION ALL
  SELECT 2, 'stage 1 — skipped (closed before the stage existed)', count(*)::text
    FROM client_months WHERE 'revenue_allocated_at' = ANY(coalesce(skipped_stages, '{}'))
  UNION ALL
  SELECT 3, 'stage 1 — still pending (genuinely open months)', count(*)::text
    FROM client_months
   WHERE revenue_allocated_at IS NULL
     AND NOT ('revenue_allocated_at' = ANY(coalesce(skipped_stages, '{}')))
  UNION ALL
  SELECT 4, 'job-cost accounts now parented (expect 4 = 2 accounts x CA/US)', count(*)::text
    FROM master_coa
   WHERE account_name IN ('Job Supplies & Materials', 'Small Tools')
     AND parent_account_name IS NOT NULL
  UNION ALL
  -- Narrowed to the sections that HAVE parents. 150's version only excluded
  -- 'equity', so it also flagged revenue, balance-sheet and QBO system accounts
  -- that are correctly top-level.
  SELECT 5, 'orphan expense/COGS leaves left for you to place',
         coalesce(string_agg(DISTINCT account_name, ', '), 'none')
    FROM master_coa
   WHERE parent_account_name IS NULL AND is_parent = false
     AND section IN ('cogs', 'operating_expense')
) v ORDER BY ord;
