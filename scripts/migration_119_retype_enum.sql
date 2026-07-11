-- Migration 119 — retype action + honest job status
-- =========================================================================
-- Run in Supabase SQL editor (each ALTER TYPE ... ADD VALUE must run outside
-- an explicit transaction — the editor runs statements individually, so just
-- paste and run):
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
--
-- 1. 'retype' — new COA action: fix an account's AccountType/AccountSubType
--    to match the standard chart (JP: "Salaries & Payroll" typed Other
--    Expense put payroll below the line on the P&L).
-- 2. 'complete_with_errors' — jobs that finished with failed actions no
--    longer show a green "complete": bookkeepers see partial failure.

ALTER TYPE coa_action ADD VALUE IF NOT EXISTS 'retype';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'complete_with_errors';
