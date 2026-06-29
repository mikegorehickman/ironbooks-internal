-- Migration 99 — billing reconciliation (the "critical number" never hides a gap)
-- billing_recon_runs        — a snapshot each time we pull a month from Stripe:
--                             gross in the account vs what we matched/recorded.
-- billing_unmatched_charges — every Stripe charge we could NOT map to a client,
--                             persisted as a worklist (not a silent delta).

create table if not exists billing_recon_runs (
  id uuid primary key default gen_random_uuid(),
  period_year int not null,
  period_month int not null,
  charge_count int not null default 0,
  matched_clients int not null default 0,
  matched_usd_cents bigint not null default 0,
  matched_cad_cents bigint not null default 0,
  unmatched_count int not null default 0,
  unmatched_usd_cents bigint not null default 0,
  unmatched_cad_cents bigint not null default 0,
  fx_usd_cad numeric not null default 1.37,
  ran_by uuid references users(id),
  ran_at timestamptz not null default now()
);
create index if not exists billing_recon_runs_period_idx on billing_recon_runs(period_year, period_month, ran_at desc);

create table if not exists billing_unmatched_charges (
  id uuid primary key default gen_random_uuid(),
  period_year int not null,
  period_month int not null,
  stripe_charge_id text not null,
  stripe_customer_id text,
  who text,                       -- email / customer id / description for display
  amount_cents bigint not null default 0,
  currency text not null default 'usd',
  created_at timestamptz not null default now()
);
create unique index if not exists billing_unmatched_charge_uid on billing_unmatched_charges(stripe_charge_id);
create index if not exists billing_unmatched_period_idx on billing_unmatched_charges(period_year, period_month);
