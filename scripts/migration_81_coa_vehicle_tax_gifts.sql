-- Migration 81 — Master COA: vehicle, fuel, taxes/licenses, insurance, gifts
-- =========================================================================
--   • Drop the "– Admin/Sales" suffix from Vehicle Lease and Vehicle Repairs
--   • Add Vehicle Loan Interest (interest on owned-vehicle loans)
--   • Rename "Fuel – Admin & Sales Vehicles" → "Fuel – Overhead" (overhead expense)
--   • Split taxes & licenses: ensure separate "Taxes" and "Licenses" accounts
--   • Add "Workman's Comp Insurance"
--   • Add "Gifts"
--
-- Run AFTER migrations 79 & 80, in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- ── Renames ─────────────────────────────────────────────────────────────
update master_coa set account_name = 'Vehicle Lease',   updated_at = now()
  where account_name = 'Vehicle Lease – Admin/Sales';

update master_coa set account_name = 'Vehicle Repairs',  updated_at = now()
  where account_name = 'Vehicle Repairs – Admin/Sales';

update master_coa
set account_name = 'Fuel – Overhead',
    section = 'operating_expense',
    expense_category = 'general_operating',
    notes = 'Overhead fuel — admin/sales/overhead vehicles. NOT direct job fuel (see Direct Fuel Allocation).',
    updated_at = now()
where account_name = 'Fuel – Admin & Sales Vehicles';

-- ── Adds (one per jurisdiction/industry present, idempotent) ─────────────
insert into master_coa (jurisdiction, account_name, parent_account_name, is_parent, qbo_account_type, qbo_account_subtype, sort_order, section, expense_category, is_required, industry)
select s.j, v.name, null, false, v.qtype, v.qsub, v.sort, 'operating_expense', 'general_operating', false, s.ind
from (select distinct jurisdiction j, industry ind from master_coa) s
cross join (values
  ('Vehicle Loan Interest',     'Expense', 'Auto',                                238),
  ('Taxes',                     'Expense', 'OfficeGeneralAdministrativeExpenses', 9002),
  ('Licenses',                  'Expense', 'OfficeGeneralAdministrativeExpenses', 9003),
  ('Workman''s Comp Insurance', 'Expense', 'Insurance',                           98),
  ('Gifts',                     'Expense', 'OfficeGeneralAdministrativeExpenses', 9004)
) as v(name, qtype, qsub, sort)
where not exists (
  select 1 from master_coa d
  where d.account_name = v.name
    and d.jurisdiction = s.j
    and coalesce(d.industry,'') = coalesce(s.ind,'')
);
