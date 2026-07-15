-- Migration 129: flatten "Job Costs - Materials & Supplies" in the master COA
--
-- Mike (2026-07-15, reviewing Dominion Painters' P&L): "Job Supplies &
-- Materials should not be a sub-account of COGS. Parent 'Materials &
-- Supplies' should be just cost of goods — remove the sub-account." (QBO:
-- uncheck "make this a subaccount", detail type = Cost of Goods Sold.)
--
-- Today the master nests a redundant parent header over its real account:
--   [parent] Job Costs - Materials & Supplies   (COGS)
--     ├─ Job Supplies & Materials               (COGS, required)
--     └─ Small Tools                            (COGS, optional)
--
-- After: both become TOP-LEVEL Cost of Goods Sold accounts and the parent
-- wrapper is removed. Small Tools is lifted to top level too (Mike named
-- only Job Supplies & Materials, but Small Tools was the parent's only other
-- child — leaving it parented to a deleted account would orphan it, so it
-- rides up to top level with the same COGS type). Applies to every
-- jurisdiction/industry that carries this structure (US + CA painters).
--
-- This is the STANDARD only. Existing clients' live QBO isn't restructured
-- by this row change — a per-client COA cleanup brings their books in line
-- (Dominion included).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1) Lift the two real accounts to top level (drop the parent link).
update master_coa
set parent_account_name = null,
    is_parent = false,
    qbo_account_type = 'Cost of Goods Sold',
    qbo_account_subtype = 'SuppliesMaterialsCogs'
where account_name in ('Job Supplies & Materials', 'Small Tools')
  and parent_account_name = 'Job Costs - Materials & Supplies';

-- 2) Remove the now-empty parent header row.
delete from master_coa
where account_name = 'Job Costs - Materials & Supplies'
  and is_parent = true;

-- Verify: the two accounts should now show parent = NULL, is_parent = false,
-- and the parent header should be gone.
select jurisdiction, industry, account_name, parent_account_name, is_parent,
       qbo_account_type, qbo_account_subtype
from master_coa
where account_name in ('Job Supplies & Materials', 'Small Tools', 'Job Costs - Materials & Supplies')
order by jurisdiction, industry, account_name;
