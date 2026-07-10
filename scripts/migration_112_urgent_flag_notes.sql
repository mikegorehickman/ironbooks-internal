-- Migration 112: urgent-support flag + client notes hardening
--
-- 1. Urgent flag on client_links — "this client needs urgent support /
--    books done ASAP". Set/cleared from the client profile; boards badge it
--    red and sort flagged clients to the top of their column.
-- 2. client_notes (from migration 23, never wired to UI — now revived as the
--    per-client Notes section): tighten RLS to INTERNAL users only. The old
--    policies allowed any authenticated user; portal clients are also
--    authenticated, so internal notes were browser-readable in principle.
--
-- Idempotent. Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1. Urgent flag
alter table client_links add column if not exists urgent_flag boolean not null default false;
alter table client_links add column if not exists urgent_flag_note text;
alter table client_links add column if not exists urgent_flag_set_at timestamptz;
alter table client_links add column if not exists urgent_flag_set_by uuid references users(id);

-- 2. client_notes: internal-only RLS (service-role API routes do the writes)
drop policy if exists "client_notes_select" on client_notes;
drop policy if exists "client_notes_insert" on client_notes;
drop policy if exists "client_notes_update" on client_notes;
drop policy if exists "Authenticated users can read notes" on client_notes;
drop policy if exists "Authenticated users can insert notes" on client_notes;
drop policy if exists "Authors can update their notes" on client_notes;

create policy "client_notes_internal_read" on client_notes
  for select to authenticated
  using (exists (
    select 1 from users u
    where u.id = auth.uid() and u.role in ('admin','lead','bookkeeper','viewer')
  ));

-- Verify
select column_name from information_schema.columns
where table_name = 'client_links' and column_name like 'urgent%';
