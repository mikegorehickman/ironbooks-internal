-- ============================================================================
-- Migration 57: UF Audit — auto-flag duplicates + create-bank-deposit resolution
-- ============================================================================
-- Two new orphan resolutions for the UF Audit workflow:
--
--   void_duplicate  — this UF payment is a DUPLICATE of another payment (same
--                     check#/amount/customer). The scanner auto-recommends it.
--                     Finalize VOIDS the duplicate Payment/SalesReceipt in QBO
--                     (operation=void) so the double-counted cash is removed.
--
--   create_deposit  — the orphan is REAL money still sitting in UF. Finalize
--                     posts a real QBO Bank Deposit (DepositToAccountRef = the
--                     chosen bank account) that LinkedTxn-references the
--                     payment, sweeping UF → Bank. This is the "clear via Bank
--                     Deposit" step that actually zeroes UF.
--
-- Also adds duplicate-detection metadata columns + deposit-target columns.
-- ============================================================================

-- 1) Extend the resolution CHECK enum -------------------------------------
ALTER TABLE uf_audit_items
  DROP CONSTRAINT IF EXISTS uf_audit_items_resolution_check;

ALTER TABLE uf_audit_items
  ADD CONSTRAINT uf_audit_items_resolution_check
  CHECK (resolution IN (
    'pending',
    'owner_draw',
    'write_off',
    'duplicate_recategorize',
    'void_duplicate',     -- NEW: void the duplicate Payment in QBO
    'create_deposit',     -- NEW: post a Bank Deposit to sweep UF → bank
    'ask_client',
    'manual_investigation',
    'executed',
    'failed',
    'skipped'
  ));

-- 2) Duplicate-detection metadata (set by the scanner) --------------------
ALTER TABLE uf_audit_items
  ADD COLUMN IF NOT EXISTS suspected_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS duplicate_of_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_reason TEXT,
  ADD COLUMN IF NOT EXISTS payment_ref_num TEXT;

-- 3) Deposit-target columns (set when resolution = create_deposit) --------
ALTER TABLE uf_audit_items
  ADD COLUMN IF NOT EXISTS deposit_bank_account_id TEXT,
  ADD COLUMN IF NOT EXISTS deposit_bank_account_name TEXT,
  -- QBO Deposit Id once the create_deposit finalize step succeeds
  ADD COLUMN IF NOT EXISTS resolution_deposit_id TEXT;

COMMENT ON COLUMN uf_audit_items.suspected_duplicate IS
  'TRUE when the scanner detected this UF payment is a likely duplicate of another (same check#/amount/customer). Auto-recommends resolution=void_duplicate.';
COMMENT ON COLUMN uf_audit_items.duplicate_of_payment_id IS
  'qbo_payment_id of the payment this one is suspected to duplicate (the original kept copy).';
COMMENT ON COLUMN uf_audit_items.duplicate_reason IS
  'Human-readable reason the scanner flagged this as a duplicate (e.g. "same check #1003 + amount as payment 412").';
COMMENT ON COLUMN uf_audit_items.deposit_bank_account_id IS
  'Target QBO bank account for resolution=create_deposit. The deposit''s DepositToAccountRef.';
COMMENT ON COLUMN uf_audit_items.resolution_deposit_id IS
  'QBO Deposit Id created by the create_deposit finalize step.';

-- Updated documentation for the resolution column
COMMENT ON COLUMN uf_audit_items.resolution IS
  'How the orphan was resolved: owner_draw (JE: Dr Owner Draw, Cr UF); write_off (Dr Bad Debt, Cr UF); duplicate_recategorize (handle in QBO manually); void_duplicate (void the duplicate Payment in QBO); create_deposit (post a Bank Deposit to sweep UF → bank); ask_client (queue email); manual_investigation (no auto-write).';
