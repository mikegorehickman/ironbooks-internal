-- Migration 79 — Split "Owner Draw / Salary" into two Master COA accounts
-- =========================================================================
-- Owner compensation has two different treatments and must not be conflated:
--   • Owner's Salary / Wages → operating EXPENSE (above net profit, a fixed cost)
--   • Owner's Draw           → EQUITY (below net profit; a distribution, NOT an expense)
--
-- The template previously had a single combined "Owner Draw / Salary" expense
-- account. This renames it to the salary/wages expense and adds a separate
-- equity "Owner's Draw" account for every jurisdiction it existed in.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1) Rename the combined account → the salary/wages EXPENSE (stays an expense).
update master_coa
set account_name = 'Owner''s Salary / Wages',
    notes = 'Owner on payroll — operating expense (fixed cost), above the net-profit line. Distinct from Owner''s Draw (equity).',
    updated_at = now()
where account_name = 'Owner Draw / Salary';

-- 2) Add the EQUITY "Owner's Draw" account for each jurisdiction/industry that
--    had the combined account — copying jurisdiction/industry/sort from it.
--    Idempotent: skip if an Owner's Draw already exists for that scope.
insert into master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, typical_pct_revenue, notes, tax_treatment, is_required, industry
)
select
  s.jurisdiction, 'Owner''s Draw', null, false,
  'Equity', 'OwnersEquity', s.sort_order + 1, 'equity',
  null, null,
  'Owner taking profit out — equity distribution below the net-profit line. NOT an expense.',
  s.tax_treatment, true, s.industry
from master_coa s
where s.account_name = 'Owner''s Salary / Wages'
  and not exists (
    select 1 from master_coa d
    where d.account_name = 'Owner''s Draw'
      and d.jurisdiction = s.jurisdiction
      and coalesce(d.industry,'') = coalesce(s.industry,'')
  );
