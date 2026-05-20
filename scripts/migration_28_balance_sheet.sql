-- Migration 28: Balance Sheet cleanup foundation
--
-- Step 5 in the cleanup workflow: reconcile bank / CC / loan accounts
-- AND match Undeposited Funds entries to open A/R invoices.
--
-- Two job tables for two distinct sub-workflows:
--
--  bank_recon_jobs   — per-account reconciliation (bookkeeper picks
--                      Checking •••1234, enters statement ending
--                      balance + date, we compare to QBO ledger).
--                      Initial schema captures the inputs; the
--                      gap-analysis stage layers in next.
--
--  uf_ar_jobs        — client-wide Undeposited Funds → A/R matching.
--                      One job per scan. Stores the matches found.
--
-- Idempotent.

-- ───── bank_recon_jobs ─────
CREATE TABLE IF NOT EXISTS bank_recon_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  bookkeeper_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The QBO account we're reconciling — Bank / Credit Card /
  -- Long Term Liability / Other Current Liability (loans).
  qbo_account_id text NOT NULL,
  qbo_account_name text NOT NULL,
  qbo_account_type text NOT NULL,
  qbo_account_last4 text,
  -- Bookkeeper-supplied truth values from the statement.
  statement_ending_balance numeric NOT NULL,
  statement_as_of_date date NOT NULL,
  -- QBO ledger balance at the statement date — captured at job
  -- creation so we have a reference point even if QBO changes later.
  qbo_balance_at_date numeric,
  -- statement - qbo (positive = QBO missing money; negative = QBO has extra)
  gap_amount numeric,
  status text NOT NULL DEFAULT 'created',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_recon_jobs_client ON bank_recon_jobs(client_link_id);
CREATE INDEX IF NOT EXISTS idx_bank_recon_jobs_status ON bank_recon_jobs(status);

-- ───── uf_ar_jobs ─────
-- Each scan of Undeposited Funds vs A/R is one job. Results land in
-- uf_ar_matches.
CREATE TABLE IF NOT EXISTS uf_ar_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  bookkeeper_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'discovering',
  -- Counts populated as the job runs.
  uf_transactions_scanned int DEFAULT 0,
  open_invoices_scanned int DEFAULT 0,
  matches_exact int DEFAULT 0,            -- invoice-number hit
  matches_high_confidence int DEFAULT 0,  -- customer + amount + close date
  matches_low_confidence int DEFAULT 0,   -- customer name only, suggestion
  unmatched_count int DEFAULT 0,
  warnings text[],
  ai_completed_at timestamptz,
  execution_started_at timestamptz,
  execution_completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uf_ar_jobs_client ON uf_ar_jobs(client_link_id);
CREATE INDEX IF NOT EXISTS idx_uf_ar_jobs_status ON uf_ar_jobs(status);

-- ───── uf_ar_matches ─────
CREATE TABLE IF NOT EXISTS uf_ar_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES uf_ar_jobs(id) ON DELETE CASCADE,
  -- The UF transaction details (snapshot at scan time)
  qbo_payment_id text NOT NULL,
  uf_customer_id text,
  uf_customer_name text,
  uf_amount numeric NOT NULL,
  uf_date date,
  uf_memo text,
  uf_invoice_reference text,  -- parsed from memo if present
  -- Match result
  match_kind text NOT NULL,  -- 'exact_invoice_number' | 'high_confidence' | 'low_confidence' | 'unmatched'
  confidence numeric,        -- 0.0 - 1.0
  -- The proposed invoice(s) to apply this UF payment to.
  -- For low_confidence cases this can hold multiple candidates the
  -- bookkeeper picks from. Each entry: {invoice_id, doc_number,
  -- customer_name, balance, txn_date, reason}.
  proposed_invoices jsonb DEFAULT '[]'::jsonb,
  -- The full candidate pool considered (for the manual picker, when
  -- the auto-suggestion isn't right).
  candidate_invoices jsonb DEFAULT '[]'::jsonb,
  -- Bookkeeper review state
  decision text NOT NULL DEFAULT 'pending',  -- 'pending' | 'auto_approve' | 'needs_review' | 'flagged'
  bookkeeper_override boolean DEFAULT false,
  selected_invoice_id text,
  executed boolean DEFAULT false,
  executed_at timestamptz,
  error_message text,
  reasoning text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uf_ar_matches_job ON uf_ar_matches(job_id);
CREATE INDEX IF NOT EXISTS idx_uf_ar_matches_decision ON uf_ar_matches(decision);

-- ───── RLS ─────
ALTER TABLE bank_recon_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE uf_ar_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE uf_ar_matches ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "bank_recon_jobs_read" ON bank_recon_jobs FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "uf_ar_jobs_read" ON uf_ar_jobs FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "uf_ar_matches_read" ON uf_ar_matches FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
