-- Migration 141 — assignable client notes
--
-- A team note can be assigned to another internal user; it then shows up on
-- that person's Home ("Notes for you") until they mark it done. Additive +
-- idempotent; safe to run more than once.

ALTER TABLE client_notes
  ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE client_notes
  ADD COLUMN IF NOT EXISTS assignee_done_at timestamptz;

-- Fast lookup for the Home widget: notes assigned to me and not yet cleared.
CREATE INDEX IF NOT EXISTS idx_client_notes_assignee_open
  ON client_notes (assignee_id)
  WHERE assignee_id IS NOT NULL AND assignee_done_at IS NULL;
