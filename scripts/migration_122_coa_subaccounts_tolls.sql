-- Migration 122 — fix orphaned payroll sub-accounts + add Tolls
-- =========================================================================
-- COA structure audit (2026-07-11) found the payroll sub-accounts still
-- pointing at parent "Salaries & Payroll", which was renamed to "Payroll"
-- (migration 80) — the parent's own name was updated but the children's
-- parent pointers weren't. Result: 7 orphaned children per jurisdiction and
-- an empty "Payroll" header. Re-point them. (This is the same mis-nesting
-- that surfaced on Dominion's run.)
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

update master_coa
   set parent_account_name = 'Payroll'
 where industry = 'painters'
   and parent_account_name = 'Salaries & Payroll';

-- Tolls — vehicle expense (Mike request). Matches the Vehicle Expenses group
-- (Expense/Auto, GIFI 9281). Additive; not applied to clients yet — use the
-- fleet Apply Standard COA tool when ready.
insert into master_coa
  (account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry, gifi_code)
select v.account_name, v.parent_account_name, v.is_parent, v.is_required, v.qbo_account_type, v.qbo_account_subtype, v.jurisdiction::jurisdiction_code, v.section::account_section, v.sort_order, v.industry, v.gifi_code
from (values
  ('Tolls', 'Vehicle Expenses', false, false, 'Expense', 'Auto', 'CA', 'operating_expense', 10020, 'painters', '9281'),
  ('Tolls', 'Vehicle Expenses', false, false, 'Expense', 'Auto', 'US', 'operating_expense', 10040, 'painters', '9281')
) as v(account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry, gifi_code)
where not exists (
  select 1 from master_coa m
  where m.account_name = v.account_name and m.jurisdiction = v.jurisdiction::jurisdiction_code and m.industry = v.industry
);

-- Sanity: expect 0 orphans and Payroll now has children.
select account_name, parent_account_name, jurisdiction
  from master_coa
 where industry = 'painters'
   and (parent_account_name = 'Salaries & Payroll' or account_name = 'Tolls')
 order by jurisdiction, account_name;
