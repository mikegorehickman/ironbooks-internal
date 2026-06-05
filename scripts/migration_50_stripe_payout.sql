-- Migration 50: stripe_payout item type for hardcore cleanup
--
-- Context:
--   Painters' Stripe revenue lands in QBO as a Bank Deposit with the
--   NET amount (gross minus Stripe fees). Without the Stripe payout
--   side-by-side, the bookkeeper can't tell:
--     - Is this bank deposit reconciled to the right Stripe payout?
--     - Was the Stripe fee booked as an expense, or absorbed into
--       Uncategorized Income / a wrong account?
--     - Did Stripe payout cover a customer-level UF payment that's
--       still sitting in Undeposited Funds?
--
--   This adds an item_type so the bookkeeper can upload a Stripe
--   Payouts CSV alongside their CRM CSV and see every payout in the
--   unified review list. v1 persists; v2 wires actual matching against
--   QBO bank deposits + UF.
--
-- Safe to re-run: DROP/ADD CHECK CONSTRAINT idempotently.

ALTER TABLE hardcore_cleanup_items
  DROP CONSTRAINT IF EXISTS hardcore_cleanup_items_item_type_check;

ALTER TABLE hardcore_cleanup_items
  ADD CONSTRAINT hardcore_cleanup_items_item_type_check
  CHECK (item_type IN (
    'duplicate_invoice','orphan_uf_payment','stale_ar','unmatched_payment',
    'missing_invoice','uf_match','unmatched_job','unmatched_uf',
    'payroll_double_entry',
    'uf_to_ar_match',
    'uncat_income',
    'stripe_payout'  -- v6 — uploaded Stripe payout from CSV
  ));

SELECT 'migration_50 applied' AS status;
