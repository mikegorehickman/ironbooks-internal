-- Migration 117 — source bank/CC account on reclassification rows
-- =========================================================================
-- JP workflow (2026-07-10 call): bookkeepers clear one bank/card account at a
-- time. Rows now record which account the money moved through (Purchase/
-- Expense header AccountRef; "Accounts Payable" for Bills/VendorCredits) so
-- the review screen can show and filter by source account.
--
-- PASTE BEFORE MERGING the companion PR — discovery inserts name this column.
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table reclassifications
  add column if not exists bank_account_name text;

comment on column reclassifications.bank_account_name is
  'Bank/CC account the transaction moved through (QBO header AccountRef); "Accounts Payable" for Bills/VendorCredits; null for legacy rows';
