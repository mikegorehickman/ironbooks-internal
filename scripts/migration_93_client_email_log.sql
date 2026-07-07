<<<<<<< HEAD
-- Migration 93: client_email_log — per-client outbound email audit trail
--
-- Backs the "Email History" tab on the client profile and the delivery-status
-- column. One row per recipient per send. Internal/bookkeeper-only (RLS allows
-- authenticated read; writes are service-role from the send routes + the Resend
-- webhook). Idempotent. Apply via the Supabase SQL editor.
--
-- Status lifecycle: 'sent' (accepted by Resend, message id stored) ->
-- 'delivered' | 'bounced' | 'complained' (set by the Resend webhook), or
=======
-- Migration 93: client_email_log + Stripe-connect reminder clock
--
-- Backs the direct-send Stripe connect email (StripeConnectModal "Send Email
-- to Client" → /api/clients/[id]/send-stripe-request). One row per recipient
-- per send. Numbered 93 to match the same table on feature/snap-v2 — when v2
-- merges, its copy of this migration no-ops (everything is idempotent).
--
-- NOTE: the send path is schema-tolerant — it works BEFORE this migration is
-- applied (the log insert + reminder-clock stamp just silently skip). Apply
-- this to start recording send history.
--
-- Status lifecycle: 'sent' (accepted by Resend, message id stored) ->
-- 'delivered' | 'bounced' | 'complained' (set by the Resend webhook, v2) or
>>>>>>> origin/main
-- 'failed' (Resend rejected the send / no provider id).

CREATE TABLE IF NOT EXISTS client_email_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id      uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  to_address          text NOT NULL,
  email_type          text NOT NULL,          -- 'stripe_connect' | 'bs_statements' | ...
  subject             text,
  status              text NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('pending','sent','delivered','bounced','complained','failed')),
  provider_message_id text,                    -- Resend email id (for webhook matching)
  error               text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_email_log_client_created
  ON client_email_log (client_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_email_log_provider_msg
  ON client_email_log (provider_message_id);

<<<<<<< HEAD
ALTER TABLE client_email_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "client_email_log_read" ON client_email_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
=======
-- Service-role only: portal clients are `authenticated` too, so no broad read
-- policy — the app reads/writes this through service-role API routes.
ALTER TABLE client_email_log ENABLE ROW LEVEL SECURITY;

-- Reminder clock on client_links (v2's cron uses these; on main they just
-- record when/what was sent so the modal + future cron agree on state).
ALTER TABLE client_links ADD COLUMN IF NOT EXISTS stripe_connect_requested_at timestamptz;
ALTER TABLE client_links ADD COLUMN IF NOT EXISTS stripe_connect_last_reminder_at timestamptz;
ALTER TABLE client_links ADD COLUMN IF NOT EXISTS stripe_connect_reminder_count integer NOT NULL DEFAULT 0;
>>>>>>> origin/main

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_email_log'
ORDER BY ordinal_position;
