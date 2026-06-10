-- Migration 61: portal A/R dismissals
-- ====================================
-- Clients can dismiss an open invoice from their "Who owes you" page when
-- it isn't real A/R (duplicate, already paid offline, not theirs). The
-- dismissal persists across logins and survives QBO re-fetches — the page
-- filters dismissed invoices out server-side regardless of QBO state.
-- Restoring deletes the row. Each dismissal is also mirrored into
-- client_communications so the bookkeeper sees it on /today and can fix
-- the books for real.
--
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS portal_ar_dismissals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  qbo_invoice_id  text NOT NULL,
  doc_number      text,
  customer_name   text,
  amount          numeric,
  reason          text,
  dismissed_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_link_id, qbo_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_ar_dismissals_client
  ON portal_ar_dismissals (client_link_id);
