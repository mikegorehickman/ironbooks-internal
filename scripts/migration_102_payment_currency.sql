-- migration 102 — per-payment currency on billing_payments.
-- Manual payments (e-transfer / cheque / cash) and expected future payments
-- can be USD or CAD independent of the client's subscription currency.
-- Nullable (existing rows fall back to the client's row currency); idempotent.
-- Supabase SQL editor: https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table billing_payments
  add column if not exists currency text;

alter table billing_payments
  drop constraint if exists billing_payments_currency_chk;
alter table billing_payments
  add constraint billing_payments_currency_chk
  check (currency is null or currency in ('usd', 'cad'));
