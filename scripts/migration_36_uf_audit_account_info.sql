-- ============================================================================
-- Migration 36: UF Audit — persist account name + current balance
-- ============================================================================
-- After Clean Cut Painters showed UF $338K balance but zero results, we
-- need to surface the *actual* QBO UF account name + balance so bookkeepers
-- can tell at a glance whether (a) the picker grabbed the wrong account,
-- (b) the activity is older than the lookback window, or (c) the entries
-- are JEs/Deposits rather than Receive Payments (a known scanner gap).
-- ============================================================================

ALTER TABLE uf_audit_scans
  ADD COLUMN IF NOT EXISTS uf_account_name TEXT,
  ADD COLUMN IF NOT EXISTS uf_account_current_balance NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN uf_audit_scans.uf_account_current_balance IS
  'Snapshot of the UF account balance at scan time. If this is large but uf_payments_total is 0, the entries are likely non-Payment (JE, manual Deposit) and the UF Audit scanner does not see them yet.';
