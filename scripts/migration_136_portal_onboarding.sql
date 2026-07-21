-- Migration 136 — client-facing portal onboarding wizard (Mike 2026-07-20)
-- One jsonb per client tracks the client's progress through the in-portal
-- onboarding guide (watch the video → complete the foundation intake → send
-- documents). Drives the "show it by default + nag until done" behavior and
-- lets the bookkeeper see where the client is. Additive + nullable.
--
-- Shape: {
--   "video_watched_at":  timestamptz | null,
--   "form_submitted_at": timestamptz | null,   -- foundation intake done
--   "docs_provided_at":  timestamptz | null,   -- client marked docs sent/uploaded
--   "completed_at":      timestamptz | null,   -- whole wizard finished
--   "accounts_attested": bool                  -- "these are all my accounts & loans"
-- }

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS portal_onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;
