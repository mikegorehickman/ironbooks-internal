-- Migration 128: allow 'ready_for_review' as a production board_status
--
-- Bug (Mike, 2026-07-15): "moving clients to Ready for Manager Review — they
-- are not being moved on the production board." Commit 39f4087 added the new
-- "Ready for Manager Review" column and made the API + UI accept
-- board_status='ready_for_review', but the DB CHECK constraint from
-- migration 65 still only allowed ('not_started','in_progress','stuck',
-- 'waiting_client'). So the board move's upsert was rejected by Postgres,
-- the route 500'd, and the UI silently swallowed it — the card never moved.
--
-- This widens the constraint to include 'ready_for_review'. 'not_started'
-- stays valid (legacy rows still exist; the column was folded into In
-- Progress in the UI, not dropped from the DB).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table monthly_rec_runs
  drop constraint if exists monthly_rec_runs_board_status_check;

alter table monthly_rec_runs
  add constraint monthly_rec_runs_board_status_check
  check (board_status in ('not_started', 'in_progress', 'stuck', 'waiting_client', 'ready_for_review'));

-- Verify (should list the new definition including ready_for_review)
select pg_get_constraintdef(oid)
from pg_constraint
where conname = 'monthly_rec_runs_board_status_check';
