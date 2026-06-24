-- Migration 95: paid one-time coaching-call booking (Lisa & Kedma, $150 / 30 min)
-- Idempotent. Apply via the Supabase SQL editor.
--
-- coaching_call_settings : per-coach config (name + the GHL calendar embed the
--   booking page renders + active flag). Stripe price IDs live in env
--   (STRIPE_COACHING_PRICE_USD / _CAD); the display price is configurable here.
-- coaching_call_bookings : one row per purchase. `token` is the single-use key
--   the post-payment /book/[token] page is gated on; consumed_at locks it once
--   the GHL appointment webhook reports the call was booked.

CREATE TABLE IF NOT EXISTS coaching_call_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_key       text NOT NULL UNIQUE,            -- 'lisa' | 'kedma'
  coach_name      text NOT NULL,
  ghl_calendar_id text,                            -- for appointment-webhook matching
  ghl_embed_url   text,                            -- the iframe src shown after payment
  price_cents     integer NOT NULL DEFAULT 15000,  -- display only ($150)
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coaching_call_bookings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token                      text NOT NULL UNIQUE,
  coach_key                  text NOT NULL,
  buyer_user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  buyer_client_link_id       uuid REFERENCES client_links(id) ON DELETE SET NULL,
  buyer_email                text,
  buyer_name                 text,
  currency                   text NOT NULL DEFAULT 'usd',     -- 'usd' | 'cad'
  stripe_checkout_session_id text,
  payment_status             text NOT NULL DEFAULT 'pending'  -- pending | paid | failed
                               CHECK (payment_status IN ('pending','paid','failed')),
  booked_at                  timestamptz,                     -- when they picked a slot
  ghl_appointment_id         text,
  consumed_at                timestamptz,                     -- single-use lock
  expires_at                 timestamptz,                     -- link validity
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_bookings_token ON coaching_call_bookings (token);
CREATE INDEX IF NOT EXISTS idx_coaching_bookings_session ON coaching_call_bookings (stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_coaching_bookings_buyer ON coaching_call_bookings (buyer_client_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_bookings_match
  ON coaching_call_bookings (coach_key, payment_status, consumed_at);

-- Seed the two coaches (no embed yet — fill in via the settings UI).
INSERT INTO coaching_call_settings (coach_key, coach_name, sort_order)
VALUES ('lisa', 'Lisa', 0), ('kedma', 'Kedma', 1)
ON CONFLICT (coach_key) DO NOTHING;

ALTER TABLE coaching_call_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_call_bookings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "coaching_settings_read" ON coaching_call_settings FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "coaching_bookings_read" ON coaching_call_bookings FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

SELECT 'coaching_call_settings' AS t, count(*) FROM coaching_call_settings
UNION ALL SELECT 'coaching_call_bookings', count(*) FROM coaching_call_bookings;
