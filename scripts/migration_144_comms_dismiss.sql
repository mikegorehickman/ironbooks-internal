-- Migration 144: dismiss inbound client messages
--
-- Problem this fixes: `read_at` was doing double duty as "handled". Opening
-- a thread marks every inbound row read ON MOUNT — no reply required — so a
-- message you glanced at and meant to come back to vanished from /today, the
-- sidebar badge and the /clients badge within seconds. There was no way to
-- say "I saw this and it needs no reply" versus "I read it and still owe them
-- an answer", and the two are different jobs.
--
-- After this migration:
--   read_at       still just means "a bookkeeper laid eyes on it" (styling)
--   dismissed_at  means HANDLED — set by replying, or by the explicit
--                 Dismiss button when no reply is warranted
--
-- Every attention surface (/today inbound widget, sidebar unread badge,
-- /clients per-client badge, /inbox unread counts) keys off dismissed_at
-- IS NULL from here on. Dismissal is reversible — the thread view shows
-- dismissed rows tagged with who dismissed them plus an Undo.
--
-- Safe to re-run: IF NOT EXISTS guards + an idempotent backfill.

ALTER TABLE client_communications
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill. Under the old model "read" WAS "handled", so everything already
-- read has effectively been dealt with. Without this, flipping the queries
-- over to dismissed_at would resurface the entire message history as unread
-- work on every bookkeeper's Home page the moment this ships.
UPDATE client_communications
   SET dismissed_at = read_at,
       dismissed_by = read_by
 WHERE direction = 'from_client'
   AND read_at IS NOT NULL
   AND dismissed_at IS NULL;

-- Replaces idx_client_comms_unread_from_client as the hot path for the
-- fleet-wide "still needs a human" scan. The old index stays — /portal and
-- the read-receipt UI still filter on read_at.
CREATE INDEX IF NOT EXISTS idx_client_comms_open_from_client
  ON client_communications (created_at DESC)
  WHERE direction = 'from_client' AND dismissed_at IS NULL;

-- Per-client variant for the /clients badge + per-thread counts.
CREATE INDEX IF NOT EXISTS idx_client_comms_open_by_client
  ON client_communications (client_link_id)
  WHERE direction = 'from_client' AND dismissed_at IS NULL;

COMMENT ON COLUMN client_communications.dismissed_at IS
  'Inbound message handled — replied to, or explicitly dismissed as needing no reply. Drives every staff attention surface. NULL = still owed a response.';
COMMENT ON COLUMN client_communications.dismissed_by IS
  'Staff user who dismissed (or whose reply auto-dismissed) this message.';

SELECT 'migration_144 applied' AS status;
