-- Migration 84: portal A/P (bill) dismissals
-- ===========================================
-- Mirror of migration 61 (portal_ar_dismissals) for the "What you owe" page.
-- Clients can dismiss an open BILL when it isn't really owed (duplicate,
-- already paid offline, not theirs). The dismissal persists across logins and
-- survives QBO re-fetches — the page filters dismissed bills out server-side
-- regardless of QBO state. Restoring deletes the row. Each dismissal is also
-- mirrored into client_communications so the bookkeeper sees it on /today and
-- can clear it in QuickBooks for real (void / bill credit).
--
-- Idempotent — safe to run more than once.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

CREATE TABLE IF NOT EXISTS portal_ap_dismissals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  qbo_bill_id     text NOT NULL,
  doc_number      text,
  vendor_name     text,
  amount          numeric,
  reason          text,
  dismissed_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_link_id, qbo_bill_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_ap_dismissals_client
  ON portal_ap_dismissals (client_link_id);
