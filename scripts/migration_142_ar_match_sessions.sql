-- Migration 142: client invoice-match sessions (A/R integrity remediation)
-- =========================================================================
-- The client-facing leg of the phantom-A/R fix (All Inspired pattern: CRM
-- invoices in QBO whose paying deposit was categorized to revenue instead of
-- being applied, so the invoice never closed).
--
-- Flow: bookkeeper sends a session of unresolved CURRENT-YEAR open invoices
-- (closed fiscal years are excluded — those are prior-period-adjustment
-- territory, CPA sign-off). The client answers per invoice in the portal:
--   paid_matched  — picked one of the machine-proposed candidate deposits
--   paid_no_match — says it's paid but none of the candidates fit
--   not_owed      — duplicate / cancelled invoice (void proposal, human-gated)
--   still_owed    — genuinely outstanding (real A/R → chase list)
--
-- A paid_matched answer on an EXACT candidate auto-applies to QBO only when
-- the session was sent with auto_apply=true (admin/lead choice at send time);
-- everything else lands as a proposal for the bookkeeper to action.
--
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS ar_match_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'open',   -- open | completed | cancelled
  -- Exact-candidate client confirmations write straight to QBO. Set only by
  -- admin/lead at send time; default OFF (proposals-only).
  auto_apply      boolean NOT NULL DEFAULT false,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ar_match_sessions_client
  ON ar_match_sessions (client_link_id, status);

CREATE TABLE IF NOT EXISTS ar_match_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES ar_match_sessions(id) ON DELETE CASCADE,
  client_link_id     uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,

  -- Invoice snapshot at send time (QBO stays the source of truth; these make
  -- the portal render + the audit trail readable without re-fetching).
  qbo_invoice_id     text NOT NULL,
  doc_number         text,
  customer_name      text,
  txn_date           date,
  amount             numeric,          -- invoice total
  balance            numeric,          -- open balance at send time

  -- Machine-proposed candidate deposits, JSON array:
  -- [{ txn_id, date, account, customer, amount, tax_label, same_customer,
  --    days_apart, exact_eligible }]
  candidates         jsonb NOT NULL DEFAULT '[]',

  -- Client answer
  answer             text,             -- paid_matched | paid_no_match | not_owed | still_owed
  matched_deposit_id text,             -- candidate txn_id the client picked
  client_note        text,
  answered_at        timestamptz,

  -- Resolution
  outcome            text,             -- auto_applied | proposed | applied_by_bookkeeper | kept | dismissed
  outcome_detail     text,
  applied_at         timestamptz,
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, qbo_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_ar_match_items_session
  ON ar_match_items (session_id);

CREATE INDEX IF NOT EXISTS idx_ar_match_items_client
  ON ar_match_items (client_link_id);

-- The bookkeeper's action queue: answered but not yet resolved.
CREATE INDEX IF NOT EXISTS idx_ar_match_items_proposals
  ON ar_match_items (client_link_id)
  WHERE outcome = 'proposed';
