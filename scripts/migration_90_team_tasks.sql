-- Migration 90 — team_tasks (internal task board)
-- =========================================================================
-- Replaces DoubleHQ's "non-closing tasks": a shared to-do / assignment board
-- for the bookkeeping team. Tasks can stand alone or be tied to a client.
-- Internal-only (clients never see these). Additive + idempotent.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists team_tasks (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  notes           text,
  status          text not null default 'todo'
                    check (status in ('todo', 'in_progress', 'done')),
  priority        text not null default 'normal'
                    check (priority in ('low', 'normal', 'high')),
  assignee_id     uuid references users(id) on delete set null,
  created_by      uuid references users(id) on delete set null,
  client_link_id  uuid references client_links(id) on delete set null,
  due_date        date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists idx_team_tasks_assignee on team_tasks (assignee_id);
create index if not exists idx_team_tasks_status   on team_tasks (status);
create index if not exists idx_team_tasks_client   on team_tasks (client_link_id);
