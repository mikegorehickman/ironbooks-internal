-- migration 103 — per-cell notes on the billing grid.
-- A free-text note / collection note attached to one (client, year, month)
-- cell, shown on hover in /admin/billing. Independent of billing_payments so a
-- cell with no payment (expected / future / missed) can still carry a note.
-- One note per cell; idempotent.
-- Supabase SQL editor: https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

CREATE TABLE IF NOT EXISTS billing_cell_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  period_year   int  NOT NULL,
  period_month  int  NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  note          text NOT NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_link_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_billing_cell_notes_client_period
  ON billing_cell_notes (client_link_id, period_year);
