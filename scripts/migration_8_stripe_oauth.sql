-- Migration 8: Stripe OAuth Connect
-- ────────────────────────────────────
-- Adds Stripe Connect (read-only OAuth) fields to client_links and a new
-- stripe_connect_tokens table for the public landing-page URLs that bookkeepers
-- send to clients to initiate connection.
--
-- After running this migration, you also need to set these env vars in Vercel:
--   - STRIPE_CONNECT_CLIENT_ID  (your platform Connect Client ID, ca_xxx)
--   - STRIPE_SECRET_KEY         (your platform secret key, sk_xxx)
--   - NEXT_PUBLIC_BASE_URL      (https://internal.ironbooks.com)

-- 1. Add Stripe Connect columns to client_links
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS stripe_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_access_token text,
  ADD COLUMN IF NOT EXISTS stripe_refresh_token text,
  ADD COLUMN IF NOT EXISTS stripe_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_connection_status text DEFAULT 'not_set';

-- Validate connection status values
ALTER TABLE client_links
  DROP CONSTRAINT IF EXISTS chk_stripe_connection_status;
ALTER TABLE client_links
  ADD CONSTRAINT chk_stripe_connection_status
  CHECK (stripe_connection_status IN ('not_set', 'pending', 'connected', 'declined'));

-- Backfill: existing clients are 'not_set'
UPDATE client_links SET stripe_connection_status = 'not_set' WHERE stripe_connection_status IS NULL;

-- 2. stripe_connect_tokens — one-time-use URLs for the branded landing page
CREATE TABLE IF NOT EXISTS stripe_connect_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,            -- the URL slug, e.g., a 32-char hex string
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,        -- 7 days from creation by default
  used_at timestamptz,                    -- NULL until the client connects
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_tokens_token ON stripe_connect_tokens(token);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_tokens_client ON stripe_connect_tokens(client_link_id);
CREATE INDEX IF NOT EXISTS idx_stripe_connect_tokens_expires ON stripe_connect_tokens(expires_at);

-- 3. RLS — service-role only for tokens, authenticated read for status checks
ALTER TABLE stripe_connect_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "stripe_connect_tokens_read" ON stripe_connect_tokens
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
