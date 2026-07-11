-- Migration 116 — master_coa template batch (JP audit follow-ups, approved by Mike 2026-07-11)
-- =========================================================================
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
--
-- 1. SUPPLIES MERGE (decided on the JP call): "Paint & Materials" + "Job
--    Supplies" collapse into one leaf, "Job Supplies & Materials" — simpler,
--    less paint-specific. The COA engine then renames/merges client accounts
--    to the new name on their next cleanup; the vendor KB is retargeted in
--    the same release.
-- 2. Discounts — contra-revenue leaf. The template had NO discount account
--    (client Discounts accounts were being deleted with nowhere to merge).
-- 3. Owner Contributions — the equity money-IN counterpart to Owner's Draw.
-- 4. Workers-comp consolidation: "Workman's Comp Insurance" duplicated
--    "Workers Compensation – Field" (same parent, same GIFI). Keep the
--    Workers Compensation pair (generic naming, not Ontario-specific per
--    Mike); drop the duplicate.
--
-- All idempotent. Order matters: rename before delete.

-- ── 1. Supplies merge ────────────────────────────────────────────────────
-- Rename Job Supplies → Job Supplies & Materials (keeps its row identity),
-- promote to required (it inherits Paint & Materials' core-account status).
update master_coa
   set account_name = 'Job Supplies & Materials',
       is_required = true
 where industry = 'painters'
   and account_name = 'Job Supplies';

-- Drop the now-redundant Paint & Materials leaf. Client accounts named
-- "Paint & Materials" get merged into Job Supplies & Materials by the COA
-- engine on next cleanup (AI maps them; same parent, type, and GIFI 8320).
delete from master_coa
 where industry = 'painters'
   and account_name = 'Paint & Materials';

-- ── 2. Discounts (contra-revenue) ────────────────────────────────────────
insert into master_coa
  (account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry, gifi_code)
select v.account_name, v.parent_account_name, v.is_parent, v.is_required, v.qbo_account_type, v.qbo_account_subtype, v.jurisdiction::jurisdiction_code, v.section::account_section, v.sort_order, v.industry, v.gifi_code
from (values
  ('Discounts', null, false, false, 'Income', 'DiscountsRefundsGiven', 'CA', 'revenue', 306, 'painters', '8000'),
  ('Discounts', null, false, false, 'Income', 'DiscountsRefundsGiven', 'US', 'revenue', 153, 'painters', '8000'),
-- ── 3. Owner Contributions (equity, money in) ────────────────────────────
  ('Owner Contributions', null, false, false, 'Equity', 'OwnersEquity', 'CA', 'equity', 221, 'painters', '3660'),
  ('Owner Contributions', null, false, false, 'Equity', 'OwnersEquity', 'US', 'equity', 68, 'painters', '3660')
) as v(account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry, gifi_code)
where not exists (
  select 1 from master_coa m
  where m.account_name = v.account_name and m.jurisdiction = v.jurisdiction::jurisdiction_code and m.industry = v.industry
);

-- ── 4. Workers-comp consolidation ────────────────────────────────────────
-- Duplicate of "Workers Compensation – Field" (same parent Job Costs - Labor,
-- same CostOfLabor subtype, same GIFI 8450). Client accounts with this name
-- merge into Workers Compensation – Field on next cleanup.
delete from master_coa
 where industry = 'painters'
   and account_name = 'Workman''s Comp Insurance';

-- Sanity: expect 1 Job Supplies & Materials per jurisdiction, 0 Paint & Materials,
-- 1 Discounts + 1 Owner Contributions per jurisdiction, 0 Workman's Comp.
select account_name, jurisdiction, is_required
  from master_coa
 where industry = 'painters'
   and account_name in ('Job Supplies & Materials','Paint & Materials','Discounts','Owner Contributions','Workman''s Comp Insurance')
 order by account_name, jurisdiction;
