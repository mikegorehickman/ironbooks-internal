-- Migration 76 — Bypass balance-sheet cleanup
-- =========================================================================
-- Lets a manager mark that a client does NOT need a balance-sheet cleanup, so
-- they advance past the bs_cleanup stage straight to review/production instead
-- of stalling in the BS column. Reversible (un-skip clears it).
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table client_links
  add column if not exists bs_cleanup_skipped_at timestamptz,
  add column if not exists bs_cleanup_skipped_by uuid references users(id);

comment on column client_links.bs_cleanup_skipped_at is
  'Manager marked this client as not needing a balance-sheet cleanup; advances them past the bs_cleanup stage. Null = not skipped.';
