-- Migration 130: DRAFT → VERIFIED statement stages + client gut-check reviews
--
-- Mike (2026-07-15): two stages of production statements. DRAFT for the
-- first month(s) of a client's books — sent with an unmissable "DRAFT"
-- label and a short gut-check questionnaire in the portal (all revenue
-- here? all accounts/cards/loans listed? cash payments missing? tax look
-- right?). The client approves, asks questions, or adds missing info.
-- Client approval raises a one-click "graduate to verified" item for a
-- senior; until then months keep going out as DRAFT (with a nudge).
--
-- Decisions (Mike 2026-07-15):
--   - graduation = client approves → senior confirms (never automatic)
--   - EVERY client starts in draft — one fleet-wide attestation cycle,
--     existing production clients included (JP audit alignment)
--   - no response → stay draft + nudge on the next month's email
--
-- Also part of this feature (code, not schema): statement emails no longer
-- include the financial summary in the body — clients must log in (email
-- forwarding/compromise risk).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1) Stage on the client. Default 'draft' — new clients get the cycle
--    automatically; existing clients are backfilled to 'draft' by the same
--    default (everyone gets one attestation pass).
alter table client_links
  add column if not exists statements_stage text not null default 'draft';

alter table client_links
  drop constraint if exists client_links_statements_stage_check;
alter table client_links
  add constraint client_links_statements_stage_check
  check (statements_stage in ('draft', 'verified'));

-- Who/when flipped to verified (senior one-click).
alter table client_links
  add column if not exists statements_verified_at timestamptz;
alter table client_links
  add column if not exists statements_verified_by uuid references users(id);

-- 2) Stamp what actually went out, per package — history must show whether
--    a given month was delivered as DRAFT even after the client graduates.
alter table month_end_packages
  add column if not exists sent_as_draft boolean not null default false;

-- 3) Client gut-check responses / approvals. One row per client+period,
--    upserted — a client can add info first and approve later.
create table if not exists statement_reviews (
  id uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  period_year int not null,
  period_month int not null,
  -- 'approved' | 'questions' | 'info_added'
  status text not null check (status in ('approved', 'questions', 'info_added')),
  -- {revenue_complete: bool|null, accounts_complete: bool|null,
  --  cash_payments: bool|null, tax_ok: bool|null} — null = unanswered
  answers jsonb not null default '{}'::jsonb,
  note text,
  portal_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_link_id, period_year, period_month)
);

create index if not exists idx_statement_reviews_client
  on statement_reviews (client_link_id, status);

-- Match the current interim RLS posture (blanket authenticated policy;
-- service role bypasses RLS — all portal/API access goes through it).
alter table statement_reviews enable row level security;
drop policy if exists authenticated_full_access on statement_reviews;
create policy authenticated_full_access on statement_reviews
  for all to authenticated using (true) with check (true);

-- Verify
select column_name from information_schema.columns
 where table_name = 'client_links' and column_name like 'statements_%';
select column_name from information_schema.columns
 where table_name = 'month_end_packages' and column_name = 'sent_as_draft';
select count(*) as reviews_table_exists from statement_reviews;
