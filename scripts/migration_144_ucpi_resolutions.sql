-- Migration 144: UCPI resolution questions + client answers
-- =========================================================
-- Unapplied Cash Payment Income = customer payments not applied to invoices,
-- parked on QBO's "Unapplied Cash Payment Income" account — cash-basis income
-- that may be unearned. After the statement is delivered, the client answers
-- two questions per unapplied item: (1) has it been collected? (2) is it a
-- deposit for a future job, or is the job completed? The answer routes it:
--   not collected → void;  earned → apply to the open invoice;
--   deposit       → move to a Customer-Deposits balance-sheet liability.
-- One row per (client, customer, statement period) holds the question, the
-- open-invoice snapshot shown on the client card, the two answers, and the
-- resolution state. See lib/ucpi-resolution.ts.
--
-- Accessed via service-role API routes (same as the reclass ask-client flow);
-- no RLS. Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS ucpi_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  -- Statement month the question rode out on, e.g. '2026-06'.
  period text NOT NULL,
  customer text,
  customer_id text,
  -- The unapplied payment(s) behind this UCPI (QBO Payment ids) + the $ at stake.
  payment_ids text[] NOT NULL DEFAULT '{}',
  unapplied_amount numeric NOT NULL DEFAULT 0,
  -- Candidate open invoices at question time (snapshot for the client card +
  -- so the plan is reproducible even if the live chart moves).
  open_invoices jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- pending (asked) → answered (client replied) → resolved (posted to QBO)
  --                 | dismissed (bookkeeper closed it).
  status text NOT NULL DEFAULT 'pending',
  collected boolean,                 -- Q1
  kind text,                         -- Q2: 'earned' | 'deposit'
  resolution text,                   -- 'apply_to_invoice'|'to_deposit_liability'|'void'|'manual'
  resolution_detail jsonb,           -- target invoice(s) / posted refs / reason
  answered_at timestamptz,
  answered_by text,                  -- 'client' or a user id
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One open question per (client, customer, period) — a re-scan updates in place
-- rather than piling up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ucpi_client_customer_period
  ON ucpi_resolutions (client_link_id, customer_id, period);

CREATE INDEX IF NOT EXISTS ix_ucpi_client_status
  ON ucpi_resolutions (client_link_id, status);

COMMENT ON TABLE ucpi_resolutions IS
  'Unapplied Cash Payment Income client-question flow: one row per (client, customer, statement period) with the two answers + resolution state. See lib/ucpi-resolution.ts. Migration 144.';
