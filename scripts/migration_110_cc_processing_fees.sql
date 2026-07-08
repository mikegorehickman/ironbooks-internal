-- Migration 110: Credit Card Processing Fees master account
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
--
-- Adds a "Credit Card Processing Fees" leaf account to the master COA for both
-- jurisdictions, as a FIXED cost (section = 'operating_expense' — the P&L's
-- "Fixed expenses" band, NOT COGS/variable). Sits under the Office & Admin
-- parent, right after Bank Charges (sort 113). Distinct from Bank Charges,
-- which explicitly excludes Stripe/card fees — this is the home for merchant/
-- card processing fees (Stripe, Square, terminals, gateway fees).
--
-- Master COA propagates platform-wide, so once applied this account is
-- available everywhere and gets re-offered to already-cleaned clients at
-- month-end. Idempotent (ON CONFLICT DO NOTHING).

INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required
)
VALUES
  ('US', 'Credit Card Processing Fees', 'Office & Admin', false,
   'Expense', 'BankCharges', 114, 'operating_expense',
   'general_operating',
   'Merchant / card processing fees (Stripe, Square, card terminals, payment-gateway fees). Fixed cost — operating expense, not COGS.',
   false),
  ('CA', 'Credit Card Processing Fees', 'Office & Admin', false,
   'Expense', 'BankCharges', 114, 'operating_expense',
   'general_operating',
   'Merchant / card processing fees (Stripe, Square, card terminals, payment-gateway fees). Fixed cost — operating expense, not COGS. HST ITC applies on the fee component.',
   false)
ON CONFLICT DO NOTHING;

-- Verify
SELECT jurisdiction, account_name, parent_account_name, section, expense_category, sort_order
FROM master_coa
WHERE account_name = 'Credit Card Processing Fees'
ORDER BY jurisdiction;
