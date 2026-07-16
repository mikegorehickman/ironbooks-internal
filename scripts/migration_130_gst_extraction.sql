-- Migration 130: GST/HST/PST extraction — foundations
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
--
-- Per-transaction 2026-YTD retrofit for Canadian clients: pull sales tax out of
-- income (→ GST/HST Payable, liability) and expenses (ITCs → GST/HST
-- Recoverable, asset), with PST tracked separately (BC/SK/MB file PST with the
-- PROVINCE — CRA only administers GST/HST). All CA clients are assumed
-- registered (Mike 2026-07-16); GST/PST numbers collected manually later.
--
-- Quebec is treated like HST at the combined rate but the client-facing
-- account names say QST ("GST/QST Payable" / "GST/QST Recoverable (ITRs)") —
-- those are resolved at apply time per province, NOT seeded here, so ON
-- clients don't grow QC-named accounts.
--
-- Idempotent — safe to re-run.

-- ── 1. GST/PST registration numbers (manual entry, nullable) ────────────────
alter table client_links add column if not exists gst_number text;
alter table client_links add column if not exists pst_number text;

-- ── 2. Per-category GST input treatment on the master COA ───────────────────
-- 'goods'   → carries PST in PST provinces (BC/SK/MB); ITC = GST portion only
-- 'service' → GST/HST only embedded (SK is the exception: SK PST also applies
--             to services — the planner encodes that province rule)
-- 'none'    → no ITC (exempt/zero-rated inputs, payroll, financial, equity)
alter table master_coa add column if not exists gst_input_kind text
  check (gst_input_kind in ('goods','service','none'));

-- Seed CA defaults by account name. Conservative where the rule is nuanced
-- (meals ITC is 50%-restricted → 'none'; fuel carries motor-fuel tax not PST →
-- 'service'). REVIEW LIST for Mike/CPA — flip any row with a simple UPDATE.
update master_coa set gst_input_kind = 'goods'
where jurisdiction = 'CA' and gst_input_kind is null and (
  account_name ilike '%material%' or account_name ilike '%suppl%'
  or account_name ilike '%tool%' or account_name ilike '%equipment%'
  or account_name ilike '%software%' or account_name ilike '%phone%'
  or account_name ilike '%internet%' or account_name ilike '%uniform%'
  or account_name ilike '%office%'
);

update master_coa set gst_input_kind = 'service'
where jurisdiction = 'CA' and gst_input_kind is null and (
  account_name ilike '%subcontract%' or account_name ilike '%fuel%'
  or account_name ilike '%advertis%' or account_name ilike '%marketing%'
  or account_name ilike '%rent%' or account_name ilike '%lease%'
  or account_name ilike '%repair%' or account_name ilike '%maintenance%'
  or account_name ilike '%accounting%' or account_name ilike '%bookkeep%'
  or account_name ilike '%legal%' or account_name ilike '%professional%'
  or account_name ilike '%training%' or account_name ilike '%education%'
  or account_name ilike '%travel%' or account_name ilike '%parking%'
  or account_name ilike '%toll%' or account_name ilike '%utilit%'
  or account_name ilike '%recruit%' or account_name ilike '%processing fee%'
);

-- Everything else CA defaults to 'none' (payroll, insurance, interest, bank
-- charges, government fees, meals, draws, revenue accounts, BS accounts) —
-- no ITC unless explicitly reviewed in.
update master_coa set gst_input_kind = 'none'
where jurisdiction = 'CA' and gst_input_kind is null;

-- ── 3. The balance-sheet tax accounts (CA master COA) ───────────────────────
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required
)
VALUES
  ('CA', 'GST/HST Payable', NULL, false,
   'Other Current Liability', 'OtherCurrentLiabilities', 900, 'liability',
   NULL,
   'Sales tax collected on revenue (GST or HST), owed to CRA. Filled by the GST extraction — income deposits are split gross → net revenue + this account.',
   false),
  ('CA', 'GST/HST Recoverable (ITCs)', NULL, false,
   'Other Current Asset', 'OtherCurrentAssets', 901, 'asset',
   NULL,
   'Input tax credits — GST/HST paid on business purchases, recoverable from CRA. Filled by the GST extraction — taxable expense lines are split gross → net expense + this account.',
   false),
  ('CA', 'PST Payable', NULL, false,
   'Other Current Liability', 'OtherCurrentLiabilities', 902, 'liability',
   NULL,
   'Provincial sales tax collected (BC/SK/MB), owed to the PROVINCE (separate filing from GST/HST). PST paid on purchases is NOT recoverable — it stays in the expense.',
   false)
ON CONFLICT DO NOTHING;

-- Verify
select account_name, qbo_account_type, section, gst_input_kind
from master_coa where jurisdiction = 'CA'
  and account_name in ('GST/HST Payable','GST/HST Recoverable (ITCs)','PST Payable');
select gst_input_kind, count(*) from master_coa where jurisdiction = 'CA' group by gst_input_kind;
select column_name from information_schema.columns
where table_name = 'client_links' and column_name in ('gst_number','pst_number');
