-- Migration 88 — Statement requests (bookkeeper → client, auto-clearing)
-- =========================================================================
-- When a bookkeeper requests specific statements from the BS cleanup view
-- ("Need from client"), each requested bank/CC/loan account becomes a row
-- here. The client sees them as a checklist beside the upload panel on their
-- portal Messages page; each request auto-fulfills (and disappears) once a
-- matching statement is uploaded + matched (lib/statement-intake).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists statement_requests (
  id uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  label text not null,                         -- what the client sees, e.g. "Bank statement — Chase Checking"
  account_name text,                           -- for name-based fulfilment matching
  account_kind text,                           -- bank | credit_card | loan
  qbo_account_id text,                         -- when known, the precise match target
  status text not null default 'open',         -- open | fulfilled | cancelled
  fulfilled_statement_id uuid references client_statements(id) on delete set null,
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz
);
create index if not exists statement_requests_client_status_idx
  on statement_requests(client_link_id, status);
