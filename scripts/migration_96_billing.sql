-- Migration 96 — SNAP subscription billing (IronBooks' own revenue from clients)
-- =========================================================================
-- Two tables behind /admin/billing:
--   billing_subscriptions — the master client↔Stripe-customer mapping + MRR.
--   billing_payments      — one row per collected/failed/manual payment, bucketed
--                           by month, so the grid can color each cell.
-- Synced from the IronBooks platform Stripe account, with manual entry for
-- non-Stripe methods (e-transfer, cheque…).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists billing_subscriptions (
  client_link_id uuid primary key references client_links(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  mrr_cents integer not null default 0,        -- expected monthly, from Stripe sub
  manual_mrr_cents integer,                     -- override when there's no Stripe sub
  subscription_status text,                     -- active | past_due | canceled | none
  match_method text,                            -- existing | email | name | manual
  matched_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists billing_payments (
  id uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  period_year int not null,
  period_month int not null,                    -- 1-12
  amount_cents integer not null default 0,
  status text not null,                         -- collected | failed | expected
  source text not null default 'stripe',        -- stripe | manual
  method text,                                  -- stripe | etransfer | cheque | cash | other
  kind text,                                    -- subscription | setup_fee | coaching_call | other
  stripe_invoice_id text,
  note text,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
-- One row per Stripe invoice (so re-syncs upsert instead of duplicating).
create unique index if not exists billing_payments_stripe_inv_idx
  on billing_payments(stripe_invoice_id) where stripe_invoice_id is not null;
create index if not exists billing_payments_client_period_idx
  on billing_payments(client_link_id, period_year, period_month);
