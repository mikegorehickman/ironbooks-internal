-- Migration 26: communication trackers on client cards
--
-- Three artifacts the bookkeeper has to copy/paste into Double during
-- a cleanup. We can detect that each was "created" by the platform,
-- but we can't observe outbound email — so "sent" is a manual
-- checkbox on the card view.
--
-- 1. Ask Client email — the email containing questions about unknown
--    transactions (e-transfers, mystery deposits etc) that we surface
--    from a reclass job's flagged/unknown rows. Bookkeeper clicks
--    "Generate" on the card, we capture the questions into the
--    *_created_at column, then they paste into Double and check
--    *_sent_at.
--
-- 2. Stripe Connect request — sister to the existing
--    stripe_connect_tokens.created_at. We add a separate
--    stripe_request_sent_at_confirmed_at (checkbox) because the
--    existing stripe_request_sent_at is set the same instant as
--    token creation, so it can't actually represent "I sent the
--    email" anymore.
--
-- 3. Cleanup PDF — derivable from cleanup_completed_at + saved
--    range, but we also need a "sent to client" checkbox because
--    delivery happens manually via Double.
--
-- Idempotent.

ALTER TABLE client_links
  -- Ask Client email tracker
  ADD COLUMN IF NOT EXISTS ask_client_email_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS ask_client_email_created_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ask_client_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS ask_client_email_sent_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Snapshot of the email content so the bookkeeper can recopy
  -- without regenerating, and so we have a record of what was asked.
  ADD COLUMN IF NOT EXISTS ask_client_email_body text,

  -- Stripe Connect request "sent" confirmation (created_at lives on
  -- stripe_connect_tokens — most recent row).
  ADD COLUMN IF NOT EXISTS stripe_request_sent_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_request_sent_confirmed_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Cleanup PDF "sent to client" confirmation (created when
  -- cleanup_completed_at is set; this records bookkeeper-confirmed
  -- delivery).
  ADD COLUMN IF NOT EXISTS cleanup_pdf_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_pdf_sent_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND column_name IN (
    'ask_client_email_created_at',
    'ask_client_email_sent_at',
    'ask_client_email_body',
    'stripe_request_sent_confirmed_at',
    'cleanup_pdf_sent_at'
  )
ORDER BY column_name;
