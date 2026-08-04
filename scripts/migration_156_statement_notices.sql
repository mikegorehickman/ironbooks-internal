-- Migration 156 — Notice to Reader: statement_notices + per-user receipts
--
-- When the manager closes a month (rec-card: checks → review → attest → send),
-- they can now attach a client-facing NOTICE TO READER: standard boilerplate +
-- an AI-suggested "what we noticed / what we need from you" section + a custom
-- section, all edited by the sender. The client sees it as a modal every time
-- they open their portal P&L until they acknowledge it, can re-open it from the
-- P&L header, and can reply — the reply lands in the team inbox and emails the
-- notice's sender. (The month-stage model has named this artifact for weeks:
-- "Statements published and emailed with the notice to reader" — lib/client-months.ts.)
--
-- Shape decisions (design-reviewed):
--   - OWN TABLE, not columns on monthly_rec_runs: the runs table is saturated
--     with internal-only data (concerns, checks, review notes) and is fetched
--     select("*") into staff UIs — colocating client-facing prose there invites
--     leakage in both directions. month_end_packages is the precedent for a
--     per-close client-facing artifact in its own table.
--   - Bodies are SNAPSHOTS as sent. Editing the template later must never
--     rewrite what a client was shown; re-sends preserve the old body in the
--     statement_notice_sent audit_log row.
--   - Acknowledgement is PER PORTAL USER (a client can have owner + spouse +
--     sales lead logins) — receipts follow the client_users.last_seen_package_id
--     precedent, NOT client_communications.read_at (which is stamped client-wide
--     for all users by /api/portal/messages/read).
--   - RE-SEND INVALIDATES ACKS BY TIMESTAMP, not by deleting receipts:
--     acknowledged ⟺ receipt.acknowledged_at >= notice.sent_at. The send upsert
--     bumps sent_at, so every re-send self-invalidates stale acks with zero
--     destructive writes. (Never anchor this to monthly_rec_runs.sent_to_client_at
--     — reopening a month nulls that stamp.)
--   - sent_by_email is snapshotted so a reply can still reach the sender after
--     the staff account is deactivated (fallback order in code: live users row →
--     this snapshot → SUPPORT_INBOX_EMAIL).
--   - client_communications.notice_id links replies to the notice they answer —
--     the ask-about flow's known weakness is exactly this missing linkage.
--
-- Accessed via service-role API routes only; RLS enabled with zero policies so
-- `authenticated` (portal clients) can never read another client's notices.
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

CREATE TABLE IF NOT EXISTS statement_notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id        uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  period_year           int NOT NULL,
  period_month          int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  monthly_rec_run_id    uuid REFERENCES monthly_rec_runs(id) ON DELETE SET NULL,
  -- Patched AFTER the package builds (the notice is written first so the email
  -- teaser can never promise a notice that failed to persist).
  month_end_package_id  uuid REFERENCES month_end_packages(id) ON DELETE SET NULL,
  boilerplate_body      text NOT NULL,
  ai_body               text,
  custom_body           text,
  sent_by               uuid NOT NULL,
  sent_by_name          text,
  sent_by_email         text,
  -- Bumped on every re-send; the ack-validity anchor.
  sent_at               timestamptz NOT NULL DEFAULT now(),
  resend_count          int NOT NULL DEFAULT 0,
  first_reply_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_link_id, period_year, period_month)
);

CREATE TABLE IF NOT EXISTS statement_notice_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id        uuid NOT NULL REFERENCES statement_notices(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  first_viewed_at  timestamptz,
  -- Interpreted against notices.sent_at (>= means acked for the CURRENT text);
  -- never hard-reset, so the history of who acked which version survives.
  acknowledged_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_id, user_id)
);

ALTER TABLE client_communications
  ADD COLUMN IF NOT EXISTS notice_id uuid REFERENCES statement_notices(id) ON DELETE SET NULL;

-- "Latest notice" is sent_at-latest, not period-latest — a late out-of-order
-- close is the newest communication needing acknowledgement.
CREATE INDEX IF NOT EXISTS idx_statement_notices_client
  ON statement_notices (client_link_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notice_receipts_user
  ON statement_notice_receipts (user_id);
CREATE INDEX IF NOT EXISTS idx_client_comms_notice
  ON client_communications (notice_id) WHERE notice_id IS NOT NULL;

ALTER TABLE statement_notices         ENABLE ROW LEVEL SECURITY;  -- zero policies = service-role only
ALTER TABLE statement_notice_receipts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE statement_notices IS
  'Client-facing Notice to Reader attached to a month-end send. Bodies are snapshots as sent; sent_at bumps on re-send and invalidates acks by timestamp. See lib/statement-notices.ts. Migration 156.';
COMMENT ON TABLE statement_notice_receipts IS
  'Per-portal-user view/acknowledge state for a notice. Acked for the current text ⟺ acknowledged_at >= notices.sent_at. Migration 156.';
COMMENT ON COLUMN client_communications.notice_id IS
  'Set on from_client replies to a Notice to Reader — links the reply to the notice it answers. Migration 156.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- One result set (the editor only shows the last query).
SELECT * FROM (
  SELECT 1 AS ord, 'statement_notices table' AS check,
         count(*)::text || ' rows' AS value
    FROM statement_notices
  UNION ALL
  SELECT 2, 'statement_notice_receipts table', count(*)::text || ' rows'
    FROM statement_notice_receipts
  UNION ALL
  SELECT 3, 'client_communications.notice_id column',
         CASE WHEN count(*) = 1 THEN 'present' ELSE 'MISSING' END
    FROM information_schema.columns
   WHERE table_name = 'client_communications' AND column_name = 'notice_id'
  UNION ALL
  SELECT 4, 'RLS enabled on both tables',
         count(*)::text || ' of 2'
    FROM pg_tables
   WHERE tablename IN ('statement_notices', 'statement_notice_receipts') AND rowsecurity
) v ORDER BY ord;
