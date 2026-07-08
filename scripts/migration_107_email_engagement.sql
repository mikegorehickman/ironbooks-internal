-- Migration 107: email engagement (opened / clicked) on client_email_log
--
-- Extends the send-status ladder so the Resend webhook can record delivery
-- progress per email: sent -> delivered -> opened -> clicked (plus the terminal
-- bounced/complained/failed). Backs the status column on the "Pending Stripe
-- Invites" panel — so a bookkeeper can see whether an invite was opened /
-- clicked / expired and decide whether to resend.
--
-- Idempotent. Run in the Supabase SQL editor.
--
-- ALSO REQUIRED (external, in the Resend dashboard) for opened/clicked to flow:
--   • enable Open Tracking + Click Tracking on the sending domain
--   • add these events to the webhook: email.delivered, email.opened, email.clicked
--     (email.bounced + email.complained are already configured)

ALTER TABLE client_email_log DROP CONSTRAINT IF EXISTS client_email_log_status_check;
ALTER TABLE client_email_log
  ADD CONSTRAINT client_email_log_status_check
  CHECK (status IN ('pending','sent','delivered','opened','clicked','bounced','complained','failed'));

ALTER TABLE client_email_log ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE client_email_log ADD COLUMN IF NOT EXISTS opened_at    timestamptz;
ALTER TABLE client_email_log ADD COLUMN IF NOT EXISTS clicked_at   timestamptz;

-- Verify
SELECT status, count(*) FROM client_email_log GROUP BY status ORDER BY status;
