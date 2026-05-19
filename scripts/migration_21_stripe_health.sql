-- Migration 21: track Stripe-account "health" at connection time
--
-- The James Painting LLC incident exposed a class of bug we can't catch
-- with code alone: a client clicks the Connect link, lands on Stripe,
-- and authorizes the WRONG account — typically because they created a
-- brand-new Stripe on the spot instead of logging into the existing
-- account that's actually been receiving payouts. The connection
-- succeeds, our app reports "Stripe connected ✓", and the failure only
-- shows up when the bookkeeper tries to reconcile and gets zero matches.
--
-- This migration adds three columns we populate at OAuth callback time
-- (and refresh on-demand later). The new-recon form + clients list use
-- them to surface a "⚠ this account has no payouts" warning BEFORE the
-- bookkeeper wastes time running a recon.
--
-- Idempotent.

ALTER TABLE client_links
  -- True if the connected account has at least one payout in history.
  -- Null = never checked yet (legacy connections, pre-migration data).
  ADD COLUMN IF NOT EXISTS stripe_has_payouts boolean,
  -- When the check last ran. Used to age out stale data and decide when
  -- to auto-refresh.
  ADD COLUMN IF NOT EXISTS stripe_payouts_checked_at timestamptz,
  -- Arrival date of the most recent payout, if any. Surfaced in the UI
  -- so bookkeepers can see "last paid out Mar 17, 2026" at a glance.
  ADD COLUMN IF NOT EXISTS stripe_last_payout_at timestamptz;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND column_name IN (
    'stripe_has_payouts',
    'stripe_payouts_checked_at',
    'stripe_last_payout_at'
  )
ORDER BY column_name;
