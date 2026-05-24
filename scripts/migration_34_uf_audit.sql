-- ============================================================================
-- Migration 34: Undeposited Funds Audit
-- ============================================================================
-- Solves the "orphan UF payment" problem: Receive-Payment entries posted to
-- Undeposited Funds that have no corresponding bank deposit. Common when
-- the owner takes cash without depositing, or the deposit was categorized
-- directly to income (double-counting).
--
-- Workflow:
--   1. Scan: deterministic match every UF payment against bank deposits
--   2. Group orphans by customer for one-click resolution
--   3. Resolve: bulk JE to Owner Draw, or send-to-client email, or mark
--      individually
--   4. Finalize: post JEs to QBO via existing createJournalEntry helper
-- ============================================================================

CREATE TABLE IF NOT EXISTS uf_audit_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'scanning'
    CHECK (status IN ('scanning','review','finalizing','finalized','failed','cancelled')),

  -- Scan window
  uf_account_qbo_id TEXT,
  scan_from DATE,
  scan_to DATE,

  -- Aggregate stats
  uf_payments_total INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  orphan_count INTEGER NOT NULL DEFAULT 0,
  total_uf_balance NUMERIC NOT NULL DEFAULT 0,
  total_orphan_amount NUMERIC NOT NULL DEFAULT 0,

  duration_ms INTEGER,
  error_message TEXT,

  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalize_results JSONB
);

CREATE INDEX IF NOT EXISTS idx_uf_audit_scans_client
  ON uf_audit_scans(client_link_id, created_at DESC);

COMMENT ON TABLE uf_audit_scans IS
  'One row per UF Audit run. Each scan inspects every UF Receive-Payment + every bank deposit to find orphans.';


CREATE TABLE IF NOT EXISTS uf_audit_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES uf_audit_scans(id) ON DELETE CASCADE,
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,

  -- Source UF payment identity
  qbo_payment_id TEXT NOT NULL,
  qbo_payment_txn_type TEXT NOT NULL,
  payment_date DATE NOT NULL,
  payment_amount NUMERIC NOT NULL,
  customer_name TEXT,
  customer_qbo_id TEXT,
  applied_invoice_ids JSONB DEFAULT '[]'::jsonb,
  payment_memo TEXT,

  -- Match classification
  classification TEXT NOT NULL CHECK (classification IN ('matched','orphan')),
  matched_deposit_id TEXT,
  matched_deposit_date DATE,
  matched_deposit_amount NUMERIC,
  matched_deposit_bank_account TEXT,
  match_confidence NUMERIC,  -- 1.0 = exact amount + same day; <1 = ±N days

  -- Resolution workflow (orphans only)
  resolution TEXT NOT NULL DEFAULT 'pending'
    CHECK (resolution IN ('pending','owner_draw','write_off','duplicate_recategorize',
                          'ask_client','manual_investigation','executed','failed','skipped')),
  resolution_je_id TEXT,        -- QBO Journal Entry ID once executed
  resolution_target_account_id TEXT,
  resolution_target_account_name TEXT,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  execution_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uf_audit_items_scan
  ON uf_audit_items(scan_id);
CREATE INDEX IF NOT EXISTS idx_uf_audit_items_customer
  ON uf_audit_items(scan_id, customer_name);

COMMENT ON COLUMN uf_audit_items.classification IS
  'matched = a bank deposit was found for this UF payment (exact amount, ±14 days); orphan = no deposit found, the money never landed in the bank.';
COMMENT ON COLUMN uf_audit_items.resolution IS
  'How the orphan was resolved: owner_draw (JE: Dr Owner Draw, Cr UF); write_off (Dr Bad Debt or similar, Cr UF); duplicate_recategorize (find the actual deposit and re-categorize it to UF); ask_client (queue for email); manual_investigation (do nothing automated).';
