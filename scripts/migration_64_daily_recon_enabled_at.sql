-- Migration 64: daily_recon_enabled_at on client_links
--
-- The promote-to-production route (and the client profile UI that reads
-- it back) reference client_links.daily_recon_enabled_at, but the column
-- was never created — code was added in a previous PR without the
-- matching migration. Result: clicking "Promote to production" on any
-- client throws PGRST204 ("Could not find the 'daily_recon_enabled_at'
-- column of 'client_links' in the schema cache").
--
-- This adds the column and backfills any client already in production
-- with the current timestamp (best we can do — original enablement date
-- wasn't recorded).
--
-- Safe to re-run.

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS daily_recon_enabled_at TIMESTAMPTZ;

COMMENT ON COLUMN client_links.daily_recon_enabled_at IS
  'Timestamp when the client was promoted to production (daily_recon_enabled set true). Null for clients still in cleanup or never enabled.';

-- Backfill: anyone already in production gets ''now'' since their real
-- enablement date is lost. Only touches rows where the column is null.
UPDATE client_links
SET daily_recon_enabled_at = now()
WHERE daily_recon_enabled = true
  AND daily_recon_enabled_at IS NULL;

-- Refresh PostgREST schema cache so the API stops 404ing on the column
-- without requiring a redeploy.
NOTIFY pgrst, 'reload schema';
