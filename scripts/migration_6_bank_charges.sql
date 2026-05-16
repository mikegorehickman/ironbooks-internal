-- Migration 6: Bank Charges master account + ask_client reclass decision
-- Run in Supabase SQL editor.

-- 1. Add "Bank Charges" leaf account to master COA for both jurisdictions.
--    Positioned in operating_expense > Office & Admin parent, between
--    Accounting & Bookkeeping (sort 110) and Software Subscriptions (sort 126).
--    Using sort_order 113 to slot in cleanly.

INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required
)
VALUES
  ('US', 'Bank Charges', 'Office & Admin', false,
   'Expense', 'BankCharges', 113, 'operating_expense',
   'general_operating',
   'Bank service fees, e-transfer fees, wire transfer fees, merchant fees not from Stripe.',
   false),
  ('CA', 'Bank Charges', 'Office & Admin', false,
   'Expense', 'BankCharges', 113, 'operating_expense',
   'general_operating',
   'Bank service fees, e-transfer fees, wire transfer fees, merchant fees not from Stripe. HST ITC applies on the fee component.',
   false)
ON CONFLICT DO NOTHING;

-- 2. Add ask_client to the reclass_decision enum.
--    Used for e-transfers, Venmos, Zelles, and other peer-payment transactions
--    where the bookkeeper needs to confirm with the client what it was for.
ALTER TYPE reclass_decision ADD VALUE IF NOT EXISTS 'ask_client';
