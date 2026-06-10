-- Migration 58: client communications (messages, notifications, file uploads)
--
-- Powers three surfaces:
--   1. /portal/messages — clients message their bookkeeper + upload
--      statements (attachments live in the private `client-uploads`
--      Storage bucket; this table stores path metadata only)
--   2. Portal nav unread badge — bookkeeper→client notifications
--   3. /today "Inbound from clients" widget + /clients/[id]/messages —
--      bookkeeper side of the same thread
--
-- direction:
--   to_client    bookkeeper/admin → client (message or notification)
--   from_client  client → bookkeeper (message, possibly with files)
-- kind:
--   message       two-way conversational message
--   notification  one-way announcement from the bookkeeper ("Your P&L
--                 is ready") — rendered distinctly in the portal
--
-- attachments JSONB: array of {path, name, size, content_type} where
-- path is `<client_link_id>/<yyyy-mm>/<ts>-<filename>` inside the
-- client-uploads bucket. Path prefix doubles as the ownership check.
--
-- Safe to re-run: IF NOT EXISTS guards throughout.

CREATE TABLE IF NOT EXISTS client_communications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  sender_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('to_client', 'from_client')),
  kind            TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'notification')),
  subject         TEXT,
  body            TEXT,
  attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Read receipt for the RECIPIENT side: to_client rows are marked read
  -- when the client opens /portal/messages; from_client rows when the
  -- bookkeeper opens /clients/[id]/messages.
  read_at         TIMESTAMPTZ,
  read_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Thread fetch: newest N for one client
CREATE INDEX IF NOT EXISTS idx_client_comms_client_created
  ON client_communications (client_link_id, created_at DESC);

-- Portal nav badge: unread to_client count per client
CREATE INDEX IF NOT EXISTS idx_client_comms_unread_to_client
  ON client_communications (client_link_id)
  WHERE direction = 'to_client' AND read_at IS NULL;

-- /today inbound widget: unread from_client across all clients
CREATE INDEX IF NOT EXISTS idx_client_comms_unread_from_client
  ON client_communications (created_at DESC)
  WHERE direction = 'from_client' AND read_at IS NULL;

-- RLS: same posture as month_end_packages (migration 55). All writes go
-- through API routes using the service role (which bypasses RLS); the
-- SELECT policy is defense-in-depth should anything ever query with the
-- anon/authenticated key.
ALTER TABLE client_communications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_communications_select ON client_communications;
CREATE POLICY client_communications_select ON client_communications
  FOR SELECT TO authenticated
  USING (user_can_see_client(auth.uid(), client_link_id));

COMMENT ON TABLE client_communications IS
  'Bookkeeper↔client messages, notifications, and statement uploads (portal Messages feature). Attachment files live in the client-uploads Storage bucket.';

SELECT 'migration_58 applied' AS status;
