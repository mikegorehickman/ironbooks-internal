-- Migration 127 — Reconciliation sessions (QBO-style CC/bank recon inside SNAP)
-- =========================================================================
-- SNAP preps the reconciliation (auto-match statement lines vs the QBO
-- ledger, hunt the difference), QBO stays the official record: at Finish,
-- SNAP snapshots the EXACT steps to perform in QBO's /reconcile screen
-- (ending balance, date, select-all vs uncheck-list) so the QBO action is
-- copy-paste-click. RLS on, no policies (service-role only, SNAP pattern).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists recon_sessions (
  id                   uuid primary key default gen_random_uuid(),
  client_link_id       uuid not null references client_links(id) on delete cascade,
  qbo_account_id       text not null,
  qbo_account_name     text not null,
  account_kind         text,                        -- bank | credit_card | loan
  statement_id         uuid references client_statements(id) on delete set null,
  beginning_balance    numeric,
  beginning_source     text,                        -- prior_session | qbo_asof | manual
  ending_balance       numeric not null,            -- from the statement (editable)
  statement_start_date date,
  statement_end_date   date not null,
  status               text not null default 'in_progress'
                       check (status in ('in_progress','finished','abandoned')),
  cleared_count        int not null default 0,
  difference           numeric,                     -- at last save/finish
  qbo_instructions     jsonb,                       -- Finish snapshot: exact QBO steps
  created_by           uuid references users(id),
  finished_by          uuid references users(id),
  finished_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists recon_sessions_client_idx
  on recon_sessions (client_link_id, created_at desc);
create index if not exists recon_sessions_account_idx
  on recon_sessions (client_link_id, qbo_account_id, status);
alter table recon_sessions enable row level security;

create table if not exists recon_session_txns (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references recon_sessions(id) on delete cascade,
  origin             text not null default 'qbo' check (origin in ('qbo','statement_only')),
  qbo_txn_id         text,                          -- null for statement_only rows
  txn_type           text,                          -- Purchase | Deposit | Transfer | JournalEntry | ...
  txn_date           date,
  doc_num            text,
  payee              text,
  memo               text,
  -- Signed by effect on the STATEMENT balance: bank deposits +, withdrawals -;
  -- CC charges +, CC payments -. beginning + Σ(checked) = ending.
  amount             numeric not null,
  checked            boolean not null default false,
  match_source       text,                          -- auto_statement | manual | null
  matched_line_date  date,
  matched_line_desc  text,
  created_at         timestamptz not null default now()
);
create index if not exists recon_session_txns_session_idx
  on recon_session_txns (session_id);
alter table recon_session_txns enable row level security;

-- Statements gain a pointer to the session that reconciled them.
alter table client_statements
  add column if not exists reconciled_session_id uuid references recon_sessions(id) on delete set null,
  add column if not exists reconciled_at timestamptz;
