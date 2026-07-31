-- Migration 150 — master COA: three re-parents + three new accounts
--
-- From Mike's COA review (2026-07-31). All master_coa, so it propagates to every
-- client chart platform-wide (lib/apply-master-coa.ts).
--
-- RE-PARENTS (the account keeps its history; only where it sits changes):
--   1. Bank Charges                                     Office & Admin → Financial
--      Bank fees are a cost of banking, not office admin. Under Financial they
--      sit beside interest and merchant fees, where a reader looks for them.
--   2. Continuing Education / Professional Development  Office & Admin → Professional Fees
--   3. Recruiting                                       (no parent)    → Professional Fees
--      Recruiting had no parent at all, so it rendered as a top-level orphan on
--      every statement.
--
-- NEW LEAF ACCOUNTS (never parents — a transaction must never post to a parent,
-- see lib/parent-account-guard.ts):
--   4. Marketing Labor  under Marketing      — in-house/contract marketing people
--   5. Agency Fees      under Marketing      — outside agency retainers
--   6. Car Rental       under Travel & Meals — Mike said "under Travel"; the
--      actual travel parent in the master chart is "Travel & Meals" (there is no
--      bare "Travel" parent — an earlier draft of this migration joined on
--      'Travel' and would have inserted nothing at all, silently).
--
-- Agency Fees is deliberately separate from ad spend: a retainer buys no
-- impressions, so folding it into advertising makes return-on-ad-spend look
-- worse than it is. Marketing Labor keeps marketing people out of general
-- payroll for the same reason — so marketing cost reads true.
--
-- Tax codes are copied FROM AN EXISTING SIBLING under the same parent rather
-- than hand-typed, so new accounts inherit codes already CPA-reviewed (Marketing
-- children are GIFI 8521, Travel 9200).
-- ⚠ Worth a CPA glance anyway: Marketing Labor could arguably be a wage line
-- (GIFI 9060) rather than advertising (8521). Flagged, not assumed.
--
-- Idempotent — safe to run more than once. Applies to every jurisdiction and
-- industry the parent exists in.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

BEGIN;

-- ── 1. Bank Charges → Financial ─────────────────────────────────────────────
UPDATE master_coa
SET parent_account_name = 'Financial', updated_at = now()
WHERE account_name = 'Bank Charges'
  AND coalesce(parent_account_name, '') <> 'Financial';

-- ── 2. Continuing Education / Professional Development → Professional Fees ──
-- Both dash spellings exist in the wild (en-dash vs hyphen); match loosely.
UPDATE master_coa
SET parent_account_name = 'Professional Fees', updated_at = now()
WHERE account_name ILIKE 'Continuing Education%Professional Development%'
  AND coalesce(parent_account_name, '') <> 'Professional Fees';

-- ── 3. Recruiting → Professional Fees (was an orphan) ──────────────────────
UPDATE master_coa
SET parent_account_name = 'Professional Fees', updated_at = now()
WHERE account_name = 'Recruiting'
  AND coalesce(parent_account_name, '') <> 'Professional Fees';

-- ── 4-6. New leaf accounts, one per (jurisdiction, industry) the parent has ──
-- Inserted by selecting FROM the parent row so jurisdiction/industry/section
-- match the family being joined. expense_category is set EXPLICITLY rather than
-- inherited: parents can carry a null category, and a null there would drop the
-- account out of category rollups.
INSERT INTO master_coa (
  jurisdiction, industry, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, gifi_code, us_tax_line
)
SELECT
  p.jurisdiction, p.industry, n.account_name, n.parent_name, false,
  'Expense', n.subtype, p.sort_order + n.sort_offset, p.section,
  n.category::expense_category, n.notes, false,
  (SELECT s.gifi_code FROM master_coa s
    WHERE s.parent_account_name = n.parent_name AND s.jurisdiction = p.jurisdiction
      AND coalesce(s.industry,'') = coalesce(p.industry,'') AND s.gifi_code IS NOT NULL
    LIMIT 1),
  (SELECT s.us_tax_line FROM master_coa s
    WHERE s.parent_account_name = n.parent_name AND s.jurisdiction = p.jurisdiction
      AND coalesce(s.industry,'') = coalesce(p.industry,'') AND s.us_tax_line IS NOT NULL
    LIMIT 1)
FROM master_coa p
JOIN (VALUES
  ('Marketing Labor', 'Marketing', 'AdvertisingPromotional', 1, 'marketing',
   'In-house or contract marketing people (content, ads management, design). Keeps marketing labour out of general payroll so marketing spend reads true.'),
  ('Agency Fees', 'Marketing', 'AdvertisingPromotional', 2, 'marketing',
   'Outside marketing agency retainers and management fees. Separate from ad spend so return-on-ad-spend is not distorted by the retainer.'),
  ('Car Rental', 'Travel & Meals', 'Travel', 1, 'general_operating',
   'Rental cars on business travel. Distinct from Vehicle Expenses, which are the company''s own trucks.')
) AS n(account_name, parent_name, subtype, sort_offset, category, notes)
  ON p.account_name = n.parent_name AND p.is_parent = true
WHERE NOT EXISTS (
  SELECT 1 FROM master_coa d
  WHERE d.account_name = n.account_name
    AND d.jurisdiction = p.jurisdiction
    AND coalesce(d.industry, '') = coalesce(p.industry, '')
);

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- 1) Any parent that DOESN'T exist means its child was silently not inserted.
--    Expect zero rows.
SELECT 'MISSING PARENT — child not inserted' AS problem, needed.parent_name
FROM (VALUES ('Financial'), ('Professional Fees'), ('Marketing'), ('Travel & Meals')) AS needed(parent_name)
WHERE NOT EXISTS (
  SELECT 1 FROM master_coa p WHERE p.account_name = needed.parent_name AND p.is_parent = true
);

-- 2) The six accounts, where they now sit, and their inherited tax codes.
--    Expect Marketing Labor / Agency Fees / Car Rental to appear once per
--    jurisdiction (CA + US), each with a gifi_code.
SELECT jurisdiction, coalesce(industry, '—') AS industry, account_name,
       parent_account_name, section, sort_order, gifi_code, us_tax_line
FROM master_coa
WHERE account_name IN ('Bank Charges', 'Recruiting', 'Marketing Labor', 'Agency Fees', 'Car Rental')
   OR account_name ILIKE 'Continuing Education%'
ORDER BY jurisdiction, coalesce(industry, ''), parent_account_name, sort_order;

-- 3) Any remaining orphan leaf (renders top-level on every statement, which is
--    what Recruiting was doing until now).
SELECT jurisdiction, account_name, section
FROM master_coa
WHERE parent_account_name IS NULL AND is_parent = false AND section <> 'equity'
ORDER BY jurisdiction, account_name;
