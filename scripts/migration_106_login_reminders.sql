-- migration 106 — login-reminder tracking + email-open signal on client_links.
-- Powers the Admin → Users "Never logged in" view: last reminded date,
-- reminder count, and the last time ANY branded email to this client was
-- opened (Resend email.opened webhook — open tracking must be enabled on the
-- sending domain in the Resend dashboard, and the webhook subscribed to
-- email.opened alongside email.bounced/email.complained).
-- Idempotent — safe to run more than once.

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS login_reminder_last_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS login_reminder_count        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_opened_at        timestamptz;
