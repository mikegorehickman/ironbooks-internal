-- Migration 140 — internal reviewer notes on client statements
--
-- Lets a reviewing bookkeeper (while viewing a client's portal statement)
-- pin internal notes to a statement — "fix this before we send", "confirm this
-- line", etc. Internal-only: never shown to the real client, only when a
-- staff member is impersonating (reviewing). Optionally anchored to a line or
-- section label.

CREATE TABLE IF NOT EXISTS statement_review_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  -- which statement: 'pl' | 'bs' | 'cash_flow' | 'package'
  statement_kind text NOT NULL,
  -- for a specific published month package (e.g. '2026-05'); null = the live statement
  period         text,
  -- optional anchor within the statement (a line/section label)
  anchor         text,
  body           text NOT NULL,
  resolved_at    timestamptz,
  resolved_by    uuid,
  created_by     uuid,
  created_by_name text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_statement_review_notes_client
  ON statement_review_notes (client_link_id, statement_kind, period);
