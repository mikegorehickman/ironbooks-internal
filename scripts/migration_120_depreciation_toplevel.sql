-- Migration 120 — Depreciation cannot nest under Financial
-- =========================================================================
-- Dominion run 2026-07-11: creating "Depreciation" (Other Expense) under
-- parent "Financial" (Expense) is impossible in QBO — subaccounts must share
-- their parent's AccountType, and Other Expense/Depreciation is the only
-- valid QBO pairing for a depreciation account. Make it top-level in the
-- master template (matches how the fleet Apply tool already created it via
-- its type-mismatch fallback).
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

update master_coa
   set parent_account_name = null
 where industry = 'painters'
   and account_name = 'Depreciation';

-- Sanity: any OTHER master children whose parent has a different type?
select c.account_name  as child,
       c.qbo_account_type as child_type,
       c.parent_account_name as parent,
       p.qbo_account_type as parent_type,
       c.jurisdiction
  from master_coa c
  join master_coa p
    on p.account_name = c.parent_account_name
   and p.jurisdiction = c.jurisdiction
   and p.industry = c.industry
   and p.is_parent = true
 where c.industry = 'painters'
   and c.qbo_account_type <> p.qbo_account_type;
