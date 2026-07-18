-- Migration 133 — monthly-rec attestation scope (Mike 2026-07-17)
-- The senior now attests one of two things when closing/sending a month:
--   'pl_bs' = "P&L & Balance Sheet are accurate" (full set)
--   'pl'    = "P&L is accurate" (Balance Sheet not attested this month, or a
--             P&L-only-service client)
-- Records exactly what was signed off so the trail isn't ambiguous later.
-- Additive + nullable → safe to apply anytime; routes are resilient and
-- persist it once this runs.

ALTER TABLE monthly_rec_runs
  ADD COLUMN IF NOT EXISTS attest_scope TEXT;
