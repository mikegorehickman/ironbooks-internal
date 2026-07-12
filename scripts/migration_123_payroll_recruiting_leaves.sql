-- Migration 123 — postable Payroll Expenses + make Recruiting postable
-- =========================================================================
-- Supports the reviewed fleet vendor rules: payroll-processor debits (Gusto,
-- Paychex, ADP, QuickBooks Payroll…) need a postable home — "Payroll" is a
-- parent header — and job-board spend (Indeed…) needs "Recruiting" postable.
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1. Payroll Expenses — postable leaf under the Payroll parent.
insert into master_coa
  (account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry, gifi_code)
select v.account_name, v.parent_account_name, v.is_parent, v.is_required, v.qbo_account_type, v.qbo_account_subtype, v.jurisdiction::jurisdiction_code, v.section::account_section, v.sort_order, v.industry, v.gifi_code
from (values
  ('Payroll Expenses', 'Payroll', false, false, 'Expense', 'PayrollExpenses', 'CA', 'operating_expense', 250, 'painters', '9060'),
  ('Payroll Expenses', 'Payroll', false, false, 'Expense', 'PayrollExpenses', 'US', 'operating_expense', 250, 'painters', '9060')
) as v(account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry, gifi_code)
where not exists (
  select 1 from master_coa m
  where m.account_name = v.account_name and m.jurisdiction = v.jurisdiction::jurisdiction_code and m.industry = v.industry
);

-- 2. Recruiting — has no children; flip to a postable leaf so job-board spend posts to it.
update master_coa set is_parent = false
 where industry = 'painters' and account_name = 'Recruiting';

-- Sanity.
select account_name, parent_account_name, is_parent, jurisdiction
  from master_coa
 where industry = 'painters' and account_name in ('Payroll Expenses','Recruiting')
 order by account_name, jurisdiction;
