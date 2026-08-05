-- Migration 157: the book-defect ledger (renumbered from 156 — collided with 156_statement_notices, which is the one already applied)
--
-- THE QUESTION THIS ANSWERS: "are this client's books right, and if not, why?"
-- Today that has no answer. The knowledge is real but scattered — some findings
-- live in dup_findings, some in coa_audit_scans, some in ucpi_resolutions, some
-- only in audit_log jsonb (revenue-integrity, CRM-invoice), and several
-- scanners (payroll double-count, parent postings, COA merge JE damage) are
-- fully ephemeral: run it, read the screen, lose it.
--
-- This is NOT another scanner. It is a registry the existing scanners report
-- INTO, so "which clients are clean" becomes a query instead of a memory.
--
-- GRAIN: one row per (client_link_id, defect_type). That is deliberately the
-- product question's grain — a client either carries a defect class or doesn't.
-- Transaction-level detail stays in the scanner's own table (dup_findings et
-- al) and is summarized here as item_count + exposure_cents + detail jsonb.
-- The ledger never becomes the system of record for individual transactions.
--
-- TRUTHFULNESS: rows are reconciled by scan, not merely inserted. A fleet scan
-- reports the full current set for its defect_type; anything previously open
-- and NOT in that set is auto-resolved with resolution='no_longer_detected'.
-- Without that, this degrades into a stale to-do list within a month — which
-- is the failure mode of every "findings" table that only ever grows.
--
-- Defect TYPES are a code registry (lib/book-defects.ts), not a table: adding
-- one is a deploy, not a migration, and the labels stay next to the logic.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS book_defects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  -- Key into DEFECT_TYPES in lib/book-defects.ts. Free text on purpose: a
  -- CHECK here would mean a migration every time a scanner is added, and the
  -- registry already rejects unknown keys at the API boundary.
  defect_type     TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'remediating', 'resolved', 'accepted')),
  -- 'accepted' = seen, understood, deliberately not fixing (immaterial, or the
  -- client's own choice). Distinct from resolved so the clean count stays
  -- honest and nobody re-litigates it every sweep.

  severity        TEXT NOT NULL DEFAULT 'medium'
                    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  -- Dollar exposure where the scanner computes one. Cents, always positive.
  exposure_cents  BIGINT,
  -- How many underlying findings (transactions, accounts, customers).
  item_count      INTEGER,
  -- Scanner-shaped summary. NOT the findings themselves — a pointer plus
  -- enough to render a row without a second query.
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,

  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Advances every time a scan still sees it. Staleness here means "nobody has
  -- re-scanned", which is itself worth showing.
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  -- 'fixed' | 'no_longer_detected' | 'accepted' | 'not_a_defect'
  resolution      TEXT,
  note            TEXT,
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT book_defects_resolved_shape
    CHECK (status NOT IN ('resolved', 'accepted') OR resolved_at IS NOT NULL)
);

-- One live row per client per defect class; re-scans update rather than pile up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_defects_client_type
  ON book_defects (client_link_id, defect_type);

-- The fleet board: open defects, worst money first.
CREATE INDEX IF NOT EXISTS idx_book_defects_open
  ON book_defects (defect_type, exposure_cents DESC NULLS LAST)
  WHERE status IN ('open', 'remediating');

-- "Is THIS client clean?" — the per-client card.
CREATE INDEX IF NOT EXISTS idx_book_defects_client_open
  ON book_defects (client_link_id)
  WHERE status IN ('open', 'remediating');

-- Scan-run history. Lets the board say "conformance last checked 9 days ago"
-- instead of implying that a defect-free client has actually been looked at.
CREATE TABLE IF NOT EXISTS book_defect_scans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  defect_type    TEXT NOT NULL,
  -- NULL = fleet-wide sweep (authoritative, triggers auto-resolve).
  -- Set  = single-client scan (only reconciles that one client).
  client_link_id UUID REFERENCES client_links(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  clients_scanned INTEGER NOT NULL DEFAULT 0,
  defects_found   INTEGER NOT NULL DEFAULT 0,
  auto_resolved   INTEGER NOT NULL DEFAULT 0,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by         UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_book_defect_scans_type_ran
  ON book_defect_scans (defect_type, ran_at DESC);

-- Same posture as the rest of the tooling: service-role API routes only.
ALTER TABLE book_defects ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_defect_scans ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE book_defects IS
  'Per-client book-accuracy defect ledger. One row per (client, defect_type). Scanners report into it; fleet scans auto-resolve what they no longer detect. Answers "which clients books are trustworthy".';
COMMENT ON COLUMN book_defects.status IS
  'open | remediating | resolved | accepted. accepted = known and deliberately not being fixed — keeps the clean count honest.';
COMMENT ON TABLE book_defect_scans IS
  'When each defect type was last swept. A client with no defects is only "clean" if something actually looked.';

SELECT 'migration_157 applied' AS status;
