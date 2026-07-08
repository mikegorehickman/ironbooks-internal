-- Migration 105: Upgrade-signals dashboard (tier run-rate)
--
-- Backs /admin/upgrades — flags clients who've outgrown their service tier
-- (3 straight months over the tier's revenue cap + trailing net margin ≥ 15%).
--
-- Two tables:
--  1. client_run_rate_cache — QBO trailing-12 revenue+net per month, cached so
--     the dashboard can backfill clients that don't have 3+ closed months in
--     SNAP without re-hitting QuickBooks on every page load.
--  2. client_upgrade_actions — per-client review state (mark handled / sent /
--     upgraded / dismissed / snoozed) so resolved rows stop nagging.
--
-- The dashboard runs BEFORE this migration too — the engine reads both tables
-- defensively and degrades to closed-statement data only. Apply this to enable
-- QBO backfill + the mark-handled workflow. Idempotent.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists client_run_rate_cache (
  client_link_id   uuid not null references client_links(id) on delete cascade,
  period           text not null,                 -- 'YYYY-MM'
  revenue_cents    bigint not null default 0,     -- cash-basis Total Income
  net_income_cents bigint not null default 0,     -- cash-basis Net Income
  source           text not null default 'qbo',
  refreshed_at     timestamptz not null default now(),
  primary key (client_link_id, period)
);

create index if not exists idx_run_rate_cache_client
  on client_run_rate_cache (client_link_id);

create table if not exists client_upgrade_actions (
  client_link_id uuid primary key references client_links(id) on delete cascade,
  decision       text not null default 'pending'
                   check (decision in ('pending','upgrade_sent','upgraded','dismissed','snoozed')),
  note           text,
  snooze_until   date,
  target_tier    text check (target_tier in ('insight','discipline','vision','scale')),
  decided_by     uuid references auth.users(id) on delete set null,
  decided_at     timestamptz,
  updated_at     timestamptz not null default now()
);

-- Service-role only: read + write happen through admin API routes / server
-- components using the service client. No policies for `authenticated`, so
-- portal clients (also `authenticated`) can never see upgrade internals.
alter table client_run_rate_cache  enable row level security;
alter table client_upgrade_actions enable row level security;

-- Verify
select 'client_run_rate_cache' as tbl, count(*) from client_run_rate_cache
union all
select 'client_upgrade_actions', count(*) from client_upgrade_actions;
