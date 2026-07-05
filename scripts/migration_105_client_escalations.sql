-- migration 105 — client escalations (the one manual attention state).
-- One first-class "a senior needs to look at this client" mechanism replacing
-- scattered half-mechanisms. Escalations carry a reason + note, live on
-- every board as a red badge + strip, and resolve with one click.
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS client_escalations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id   uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'general'
                   CHECK (kind IN ('general','billing','statement','stuck_job','disconnected','client_relationship')),
  reason           text NOT NULL,               -- pre-baked picker value or free text
  note             text,                        -- optional detail
  priority         text NOT NULL DEFAULT 'high' CHECK (priority IN ('low','high')),
  raised_by        uuid REFERENCES users(id),
  assignee_id      uuid REFERENCES users(id),   -- the OWNER; escalations without owners rot
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by      uuid REFERENCES users(id),
  resolved_at      timestamptz,
  resolution_note  text,                        -- the answer, shown to the raiser for 7 days
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One OPEN escalation per (client, kind) — a second raise surfaces the
-- existing one instead of stacking duplicates. Resolved history is unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_escalations_open_unique
  ON client_escalations (client_link_id, kind) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_client_escalations_open
  ON client_escalations (status, created_at DESC) WHERE status = 'open';
