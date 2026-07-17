-- Migration 131: draft statement sends (Mike 2026-07-17)
--
-- Month-end final step gains a second path: instead of closing + sending the
-- real P&L, the bookkeeper can send the client a DRAFT with a question
-- (portal message + email) while the month stays open. Each draft send is
-- appended here so the close card shows "draft sent, waiting on client".
--
-- Apply in Supabase SQL editor (safe to re-run).

alter table monthly_rec_runs
  add column if not exists draft_sends jsonb not null default '[]'::jsonb;

comment on column monthly_rec_runs.draft_sends is
  'Array of {at, by, by_name, question, email_sent} — DRAFT P&L sends to the client (month stays open). Real close stamps completed_at/sent_to_client_at as before.';

-- Verify:
--   select column_name from information_schema.columns
--   where table_name = 'monthly_rec_runs' and column_name = 'draft_sends';
