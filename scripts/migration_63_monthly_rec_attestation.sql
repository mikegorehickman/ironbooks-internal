-- Migration 63: Monthly Rec attestation + send-to-client
-- ========================================================
-- The close gate: a month can only be completed by reviewing the financial
-- statements, attesting, and sending to the client. Adds the attestation
-- trail + statement snapshot to monthly_rec_runs.
--
-- Idempotent — safe to run more than once.

ALTER TABLE monthly_rec_runs
  ADD COLUMN IF NOT EXISTS statements        jsonb,
  ADD COLUMN IF NOT EXISTS attested_by       uuid,
  ADD COLUMN IF NOT EXISTS attested_at       timestamptz,
  ADD COLUMN IF NOT EXISTS sent_to_client_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_delivery    jsonb;
