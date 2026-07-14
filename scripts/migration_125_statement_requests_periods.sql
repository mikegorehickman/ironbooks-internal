-- Migration 125: per-account statement requests carry explicit periods + provenance
alter table statement_requests add column if not exists period_start date;
alter table statement_requests add column if not exists period_end date;
-- where this request came from: qbo_coa | bank_feed | onboarding | manual | standing (CRM/invoices)
alter table statement_requests add column if not exists source text;
-- AI-parsed ending balance from the uploaded statement (PR 2 fills this)
alter table statement_requests add column if not exists ending_balance numeric;
create index if not exists idx_statement_requests_client_acct
  on statement_requests (client_link_id, qbo_account_id, period_start);

-- Auto-recon results on the statement itself (filled at intake time)
alter table client_statements add column if not exists recon_status text;
alter table client_statements add column if not exists recon_variance numeric;
alter table client_statements add column if not exists recon_qbo_balance numeric;
