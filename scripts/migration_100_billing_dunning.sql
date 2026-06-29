-- Migration 100 — billing dunning / collections
-- Reminder cadence + portal access hold for past-due clients. SAFE by design:
-- the hold is only ever set for a CONFIRMED failed charge (never for a merely
-- "missing" payment, which could be an unmatched/unmapped Stripe payment), and
-- auto-suspend is gated behind env DUNNING_AUTOSUSPEND='true'.

-- Portal access hold (the "turn off account access" switch) + past-due marker.
alter table client_links
  add column if not exists portal_billing_hold boolean not null default false,
  add column if not exists billing_hold_at timestamptz,
  add column if not exists billing_hold_reason text,
  add column if not exists billing_past_due_since timestamptz;

-- Dunning state per subscription.
alter table billing_subscriptions
  add column if not exists last_reminder_at timestamptz,
  add column if not exists reminder_count int not null default 0,
  add column if not exists dunning_exempt boolean not null default false;
