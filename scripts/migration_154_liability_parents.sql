-- Migration 154 — liability parent accounts in the master COA
--
-- Mike (2026-08-04), trying to add "Tips Payable" in /templates: the Add Account
-- modal's parent dropdown offers COGS, operating-expense, asset, other-income
-- and other-expense parents — but no LIABILITY parent. So there is nowhere to
-- put a new liability sub-account, and Tips Payable can only be created as
-- another top-level orphan.
--
-- Adds the two parents a balance sheet actually requires:
--
--   • Current Liabilities   (Other Current Liability) — due within a year:
--     Tips Payable, Customer Deposits, sales-tax payables, accrued expenses.
--   • Long-Term Liabilities (Long Term Liability)     — due beyond a year:
--     vehicle financing, term loans, shareholder notes.
--
-- Two rather than one because current-vs-long-term is not a stylistic grouping —
-- it is THE required split on a balance sheet (working capital and every
-- liquidity ratio depend on it). A single "Liabilities" bucket would force a
-- five-year truck loan and next week's tips into the same subtotal, and we'd be
-- back adding the second parent within the month.
--
-- Deliberately NOT added, to avoid deciding structure nobody asked for:
--   • Payroll Liabilities — a reasonable third parent (source deductions, WCB).
--     One INSERT away if wanted; Tips Payable sits fine under Current for now.
--   • Credit Card parents — QBO models each card as its own top-level account.
--
-- Deliberately NOT re-parented: the existing top-level liability leaves
-- (GST/HST Payable, PST Payable) and asset leaves stay exactly where they are.
-- Moving them wasn't asked for, and migration 153 is a fresh reminder that a
-- parentless account in this chart is often somebody's deliberate decision. If
-- they should sit under Current Liabilities, that's a one-line UPDATE — but it's
-- Mike's call, not an assumption baked into 78 client charts.
--
-- is_required = false: these are structural options, not accounts every client
-- must have, so the master-COA push won't force empty parents into charts that
-- don't need them.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

INSERT INTO master_coa (
  jurisdiction, industry, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required
)
SELECT
  j.jurisdiction, j.industry, n.account_name, NULL, true,
  n.qbo_type, n.qbo_subtype,
  -- Park them after everything else in the chart so they don't shuffle the P&L
  -- ordering the team already knows.
  (SELECT coalesce(max(m.sort_order), 0) FROM master_coa m
    WHERE m.jurisdiction = j.jurisdiction
      AND coalesce(m.industry, '') = coalesce(j.industry, '')) + n.sort_bump,
  'liability', NULL, n.notes, false
FROM (
  -- Every (jurisdiction, industry) combination the chart already uses, so CA and
  -- US stay in step. Doing this by hand in /templates means adding to one
  -- jurisdiction at a time — which is exactly how the two drift apart.
  SELECT DISTINCT jurisdiction, industry FROM master_coa
) AS j
CROSS JOIN (VALUES
  ('Current Liabilities', 'Other Current Liability', 'OtherCurrentLiabilities', 10,
   'Obligations due within a year — tips payable, customer deposits, sales-tax payable, accrued expenses.'),
  ('Long-Term Liabilities', 'Long Term Liability', 'OtherLongTermLiabilities', 20,
   'Obligations due beyond a year — vehicle financing, term loans, shareholder notes.')
) AS n(account_name, qbo_type, qbo_subtype, sort_bump, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM master_coa d
  WHERE d.account_name = n.account_name
    AND d.jurisdiction = j.jurisdiction
    AND coalesce(d.industry, '') = coalesce(j.industry, '')
);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- One result set (the editor only shows the last query).
SELECT * FROM (
  -- 1) The new parents, one per jurisdiction/industry. These are what the Add
  --    Account dropdown reads, so they'll appear as parent options immediately.
  SELECT 1 AS ord,
         jurisdiction || coalesce(' · ' || industry, '') || ' · ' || account_name AS item,
         qbo_account_type || ' / ' || qbo_account_subtype ||
           ' · sort ' || sort_order::text AS value
    FROM master_coa
   WHERE account_name IN ('Current Liabilities', 'Long-Term Liabilities')

  UNION ALL
  -- 2) Every liability parent now available to the modal.
  SELECT 2, 'liability parents available in the dropdown',
         coalesce(string_agg(DISTINCT account_name, ', '), 'NONE — something went wrong')
    FROM master_coa
   WHERE section = 'liability' AND is_parent = true

  UNION ALL
  -- 3) Liability leaves still top-level. Left alone on purpose — say the word if
  --    they should move under Current Liabilities.
  SELECT 3, 'liability leaves still top-level (unchanged by design)',
         coalesce(string_agg(DISTINCT account_name, ', '), 'none')
    FROM master_coa
   WHERE section = 'liability' AND is_parent = false AND parent_account_name IS NULL
) v ORDER BY ord, item;
