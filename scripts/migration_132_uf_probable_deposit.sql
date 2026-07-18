-- Migration 132 — UF audit smart deposit matching (Mike 2026-07-18)
-- Persist the probable-deposit tie-out so an orphan that actually landed in the
-- bank (unlinked deposit — exact / bundled / CA net-of-GST/HST) is shown as
-- "probably deposited", not a hole. Suggestion only; no resolution change.
-- Additive + nullable → safe to apply anytime; the scan insert is resilient
-- and lights these up once this runs.

ALTER TABLE uf_audit_items
  ADD COLUMN IF NOT EXISTS probable_deposit_id TEXT,
  ADD COLUMN IF NOT EXISTS probable_deposit_date DATE,
  ADD COLUMN IF NOT EXISTS probable_deposit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS probable_deposit_bank TEXT,
  ADD COLUMN IF NOT EXISTS probable_match_kind TEXT,
  ADD COLUMN IF NOT EXISTS probable_match_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS probable_match_note TEXT,
  ADD COLUMN IF NOT EXISTS probable_match_group JSONB DEFAULT '[]'::jsonb;

ALTER TABLE uf_audit_scans
  ADD COLUMN IF NOT EXISTS probable_deposited_count INTEGER,
  ADD COLUMN IF NOT EXISTS probable_deposited_amount NUMERIC;
