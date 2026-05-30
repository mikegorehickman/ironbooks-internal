-- Migration 43: External invoice imports (Jobber, DripJobs)
--
-- Context:
--   BS Cleanup's gap analyzer flags "possible duplicate" invoices using
--   only QBO data — same customer + similar amount + close dates. That
--   produces false positives whenever the source app (Jobber / DripJobs)
--   created multiple legitimate invoices on one job (estimate revisions,
--   change orders, progress billing).
--
--   LT Woodworks hit this: every flagged "duplicate" was actually a Jobber
--   estimate revision producing two invoices on the same Job #.
--
--   The fix: ingest the source-of-truth CSV from Jobber/DripJobs and
--   group QBO invoices by the lineage key (Jobber `Job #` or DripJobs
--   `Proposal Name`). Two QBO invoices sharing one lineage key → never
--   a duplicate. Two with no shared key → still a duplicate candidate.
--
-- Schema:
--   external_invoice_imports — one row per uploaded file (per client per
--     source). Re-upload replaces the previous import for that
--     (client, source) pair. Bookkeeper sees "last imported" timestamp
--     and row count on the BS Cleanup landing page.
--
--   external_invoice_rows — one row per CSV line. The lineage_key column
--     is the join target for the matcher — Job # for Jobber, Proposal
--     Name for DripJobs. raw_row stores the original parsed shape for
--     debugging / showing back to the bookkeeper.
--
-- Safe to re-run: IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS external_invoice_imports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  UUID        NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  source          TEXT        NOT NULL CHECK (source IN ('jobber', 'dripjobs')),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by     UUID        REFERENCES users(id),
  filename        TEXT,
  row_count       INTEGER     NOT NULL DEFAULT 0,
  invoice_count   INTEGER     NOT NULL DEFAULT 0,
  parse_warnings  JSONB       DEFAULT '[]'::jsonb,

  -- Only one active import per (client, source). Re-upload replaces.
  UNIQUE (client_link_id, source)
);

CREATE INDEX IF NOT EXISTS external_invoice_imports_client_idx
  ON external_invoice_imports (client_link_id);

CREATE TABLE IF NOT EXISTS external_invoice_rows (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id                UUID NOT NULL REFERENCES external_invoice_imports(id) ON DELETE CASCADE,
  client_link_id           UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  source                   TEXT NOT NULL,

  -- Normalized fields the matcher reads
  customer_name            TEXT,
  customer_name_normalized TEXT,
  lineage_key              TEXT,        -- Jobber Job # or DripJobs Proposal Name
  external_invoice_id      TEXT,        -- DripJobs Invoice ID (null for Jobber)
  row_type                 TEXT,        -- invoice | payment | deposit | refund
  amount                   NUMERIC(14,2),
  issue_date               DATE,
  status                   TEXT,

  -- Original CSV row for the bookkeeper drawer
  raw_row                  JSONB,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_invoice_rows_lookup_idx
  ON external_invoice_rows (client_link_id, row_type, lineage_key);

CREATE INDEX IF NOT EXISTS external_invoice_rows_customer_idx
  ON external_invoice_rows (client_link_id, customer_name_normalized, amount, issue_date);

CREATE INDEX IF NOT EXISTS external_invoice_rows_import_idx
  ON external_invoice_rows (import_id);

-- Verify
SELECT 'external_invoice_imports' AS table_name, count(*) AS rowcount FROM external_invoice_imports
UNION ALL
SELECT 'external_invoice_rows', count(*) FROM external_invoice_rows;
