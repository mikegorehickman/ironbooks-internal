-- Migration 29: per-account categories on the Balance Sheet page
--
-- The BS Cleanup workflow asks the bookkeeper to categorize each
-- bank/CC/loan account on the client's QBO COA as one of:
--
--   personal           — commingled personal account; activity here
--                        should be moved to Owner's Equity
--   business_checking  — standard operating account
--   business_savings   — reserve / tax savings / etc.
--   loan_cc            — credit card or term loan; treated as a
--                        liability with potential principal/interest
--                        split issues
--
-- Categories are sticky — once a Chase ••1234 is flagged Personal,
-- it stays that way across cleanup cycles. Bookkeeper can change
-- on a future BS session if needed.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS client_account_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  qbo_account_id text NOT NULL,
  category text NOT NULL CHECK (
    category IN ('personal', 'business_checking', 'business_savings', 'loan_cc')
  ),
  -- Cached for display when the QBO account changes name/number later.
  qbo_account_name text,
  qbo_account_last4 text,
  set_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One category per (client, account) — UPSERT-able.
  UNIQUE (client_link_id, qbo_account_id)
);
CREATE INDEX IF NOT EXISTS idx_client_account_categories_client
  ON client_account_categories(client_link_id);

-- Add category column to bank_recon_jobs so each recon entry records
-- the category at the time (history-preserving, in case bookkeeper
-- recategorizes later).
ALTER TABLE bank_recon_jobs
  ADD COLUMN IF NOT EXISTS category text;
