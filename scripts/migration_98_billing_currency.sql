-- Migration 98 — billing currency
-- Each client's subscription bills in one currency (USD or CAD). Stored on the
-- subscription row; payments inherit it. Default from the client's jurisdiction
-- on first sync. Amounts stay in cents; this just tells the UI which symbol +
-- whether to tag "CAD", and which bucket the totals roll into.

alter table billing_subscriptions
  add column if not exists currency text not null default 'usd';   -- 'usd' | 'cad'
