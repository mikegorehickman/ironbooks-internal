-- Migration 114: AR Aging Cleanup module + module skip support
--
-- From the 2026-07-10 ops call: clearing years of stale open AR invoices is
-- the slowest manual job in the company (two full days on Clean Cut
-- Painters). New BS-cleanup module 'ar_aging' automates Lisa's process:
-- in-scope invoices get a Receive Payment to an "Uncleared Deposits"
-- clearing account (removes them from the AR Aging Detail report — a JE
-- can't do that), out-of-scope years get a lump writeoff JE.
--
-- Also adds the missing "skip a module" columns: the skipped status has
-- existed in the enum since migration 53 and the QA gate accepts it, but
-- nothing could ever set it — an untouched optional module blocked
-- delivery forever.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- The SQL editor runs statements individually, so this pastes fine as-is.

alter type cleanup_module add value if not exists 'ar_aging';

alter table cleanup_run_modules add column if not exists skipped_at timestamptz;
alter table cleanup_run_modules add column if not exists skipped_by uuid references users(id);

-- Verify
select unnest(enum_range(null::cleanup_module))::text as module;
