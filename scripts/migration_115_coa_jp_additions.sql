-- Migration 115 — master_coa additions from the JP audit (2026-07-10)
-- =========================================================================
-- JP (CGA) reviewed the painter chart live and flagged missing accounts.
-- All additive/idempotent. Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
--
-- 1. Penalties & Fines — CRA late-payment penalties + vehicle/traffic fines.
--    JP: "your system do not have penalty and settlement. You should have that
--    in your template." Non-deductible; kept as its own line for the accountant.
-- 2. Non-Deductible Interest (CRA) — CA only. JP: CRA late-payment interest gets
--    a different year-end treatment than regular interest ("non deductible
--    interest. CRA interest"). Separate from the existing "Interest Expense".
-- 3. Gifts → reparent under Marketing. JP: client-appreciation gifts "should be
--    under marketing." Existing "Gifts" rows are reparented + retyped to match.

-- Idempotent via NOT EXISTS (no reliance on a unique constraint that may not exist).
insert into master_coa
  (account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry)
select v.account_name, v.parent_account_name, v.is_parent, v.is_required, v.qbo_account_type, v.qbo_account_subtype, v.jurisdiction::jurisdiction_code, v.section::account_section, v.sort_order, v.industry
from (values
  ('Penalties & Fines', null, false, false, 'Expense', 'OtherMiscellaneousExpense', 'CA', 'operating_expense', 9005, 'painters'),
  ('Penalties & Fines', null, false, false, 'Expense', 'OtherMiscellaneousExpense', 'US', 'operating_expense', 9005, 'painters'),
  ('Non-Deductible Interest (CRA)', 'Financial', false, false, 'Expense', 'InterestPaid', 'CA', 'operating_expense', 292, 'painters')
) as v(account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype, jurisdiction, section, sort_order, industry)
where not exists (
  select 1 from master_coa m
  where m.account_name = v.account_name and m.jurisdiction = v.jurisdiction and m.industry = v.industry
);

-- Reparent + retype existing Gifts under Marketing (advertising/promotional).
update master_coa
   set parent_account_name = 'Marketing',
       qbo_account_subtype = 'AdvertisingPromotional'
 where industry = 'painters'
   and account_name = 'Gifts';
