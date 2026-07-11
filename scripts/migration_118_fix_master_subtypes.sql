-- Migration 118 — fix invalid QBO AccountSubType values in master_coa
-- =========================================================================
-- The fleet Apply Standard COA run surfaced QBO "Invalid Enumeration" 400s:
-- several master rows carry subtype strings that are not valid QBO enums.
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- "Charitable Giving" is not a QBO enum; the valid pairing is
-- Expense/CharitableContributions (also more correct than Other Expense
-- for ordinary charitable deductions).
update master_coa
   set qbo_account_type = 'Expense',
       qbo_account_subtype = 'CharitableContributions'
 where industry = 'painters' and qbo_account_subtype = 'Charitable Giving';

-- "OfficeExpenses" is not a QBO enum; valid is OfficeGeneralAdministrativeExpenses.
update master_coa
   set qbo_account_subtype = 'OfficeGeneralAdministrativeExpenses'
 where industry = 'painters' and qbo_account_subtype = 'OfficeExpenses';

-- "Other Income" (with a space) is not a QBO enum; Interest Income → InterestEarned.
update master_coa
   set qbo_account_subtype = 'InterestEarned'
 where industry = 'painters' and qbo_account_subtype = 'Other Income';

-- "Bad Debt" is not a QBO enum; valid is BadDebts.
update master_coa
   set qbo_account_subtype = 'BadDebts'
 where industry = 'painters' and qbo_account_subtype = 'Bad Debt';

-- "Incorporation" and "Recruiting" are not QBO enums; use the generic
-- miscellaneous subtype for their account type (P&L placement is driven by
-- AccountType; DetailType here is descriptive only).
update master_coa
   set qbo_account_subtype = 'OtherMiscellaneousExpense'
 where industry = 'painters' and qbo_account_subtype in ('Incorporation','Recruiting');

-- Sanity: no rows should remain with the bad values.
select account_name, jurisdiction, qbo_account_type, qbo_account_subtype
  from master_coa
 where industry = 'painters'
   and qbo_account_subtype in ('Charitable Giving','OfficeExpenses','Other Income','Bad Debt','Incorporation','Recruiting');
