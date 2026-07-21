-- Migration 138 — Failed Review stage, Manager Reject, review notes, internal videos
--
-- (166) Manager Reject bounces a file from review back to the assigned bookkeeper
--       into a new "Failed Review" stage, in both cleanup and production.
-- (167) The manager's notes persist so they're readable after approve/reject.
-- (168) Internal-only Loom links per client, scoped to P&L / P&L-only / BS.
--
-- Additive + idempotent. Safe to run against prod.

-- ── Cleanup review: reject metadata ────────────────────────────────────────
-- cleanup_review_state is free text (no CHECK) — it now also takes
-- 'failed_review'. cleanup_review_notes already exists (migration 25) and holds
-- the manager's reason. Add who/when the reject happened.
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS cleanup_review_rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_review_rejected_by uuid;

-- ── Production monthly-close review: allow 'failed_review' + reject/notes ────
ALTER TABLE monthly_rec_runs DROP CONSTRAINT IF EXISTS monthly_rec_runs_status_check;
ALTER TABLE monthly_rec_runs
  ADD CONSTRAINT monthly_rec_runs_status_check
  CHECK (status IN ('open', 'pending_review', 'failed_review', 'complete'));

ALTER TABLE monthly_rec_runs
  ADD COLUMN IF NOT EXISTS review_notes text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid;

-- ── Internal review videos (168) ────────────────────────────────────────────
-- Per-client Loom links for internal review, NOT client-facing. Shape:
--   { "pl": "https://loom…", "pl_only": "https://loom…", "bs": "https://loom…" }
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS internal_review_videos jsonb NOT NULL DEFAULT '{}'::jsonb;
