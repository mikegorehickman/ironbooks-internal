-- migration 101 — billing_day: the day of the month a client's payment is
-- expected to come in (e.g. 5 = the 5th). Shown as the 3rd column of the
-- billing sheet and editable there. Nullable; idempotent.
-- Supabase SQL editor: https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table billing_subscriptions
  add column if not exists billing_day smallint;

alter table billing_subscriptions
  drop constraint if exists billing_subscriptions_billing_day_chk;
alter table billing_subscriptions
  add constraint billing_subscriptions_billing_day_chk
  check (billing_day is null or (billing_day between 1 and 31));
