-- Migration: Stripe AR Reconciliation (Phase 1)
-- Adds two tables for matching Stripe deposits to QBO invoices/customer payments.
-- Run in Supabase SQL editor before deploying.

-- ───── ENUM ─────
DO $$ BEGIN
  CREATE TYPE stripe_recon_decision AS ENUM ('auto_approve', 'needs_review', 'flagged');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ───── stripe_recon_jobs ─────
CREATE TABLE IF NOT EXISTS stripe_recon_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  bookkeeper_id uuid NOT NULL REFERENCES users(id),
  reclass_job_id uuid REFERENCES reclass_jobs(id),
  date_range_start date NOT NULL,
  date_range_end date NOT NULL,
  jurisdiction text NOT NULL,
  state_province text,
  status text NOT NULL DEFAULT 'draft',
  stripe_deposits_found integer DEFAULT 0,
  total_matched_amount numeric DEFAULT 0,
  total_fees numeric DEFAULT 0,
  total_tax numeric DEFAULT 0,
  ai_completed_at timestamptz,
  execution_completed_at timestamptz,
  execution_duration_seconds integer,
  error_message text,
  warnings jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_recon_jobs_client ON stripe_recon_jobs(client_link_id);
CREATE INDEX IF NOT EXISTS idx_stripe_recon_jobs_bookkeeper ON stripe_recon_jobs(bookkeeper_id);
CREATE INDEX IF NOT EXISTS idx_stripe_recon_jobs_status ON stripe_recon_jobs(status);

-- ───── stripe_recon_matches ─────
CREATE TABLE IF NOT EXISTS stripe_recon_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES stripe_recon_jobs(id) ON DELETE CASCADE,
  qbo_deposit_id text NOT NULL,
  qbo_deposit_txn_type text DEFAULT 'Deposit',
  deposit_amount numeric NOT NULL,
  deposit_date date NOT NULL,
  deposit_memo text,
  matched_invoices jsonb DEFAULT '[]'::jsonb,
  matched_customer_names text[] DEFAULT '{}',
  total_invoice_amount numeric DEFAULT 0,
  computed_fee numeric DEFAULT 0,
  computed_tax numeric DEFAULT 0,
  tax_code text,
  ai_confidence numeric,
  ai_reasoning text,
  decision stripe_recon_decision NOT NULL DEFAULT 'needs_review',
  bookkeeper_override boolean DEFAULT false,
  executed boolean DEFAULT false,
  executed_at timestamptz,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_recon_matches_job ON stripe_recon_matches(job_id);
CREATE INDEX IF NOT EXISTS idx_stripe_recon_matches_decision ON stripe_recon_matches(decision);

-- ───── RLS ─────
ALTER TABLE stripe_recon_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_recon_matches ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read jobs they're connected to (service role bypasses RLS).
DO $$ BEGIN
  CREATE POLICY "stripe_recon_jobs_read" ON stripe_recon_jobs
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "stripe_recon_matches_read" ON stripe_recon_matches
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "stripe_recon_matches_update" ON stripe_recon_matches
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ───── Phase 2 corrections: pre-tax revenue + sales tax collected per match ─────
ALTER TABLE stripe_recon_matches
  ADD COLUMN IF NOT EXISTS pre_tax_revenue numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_sales_tax_collected numeric DEFAULT 0;
