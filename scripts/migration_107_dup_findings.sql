-- migration 107 — duplicate-transaction findings (the dedupe pipeline).
-- One row per detected duplicate GROUP (2+ QBO transactions that look like
-- the same money twice). Findings come from the reclass Duplicates stage,
-- the weekly production sweep, and the one-time admin clean sweep — all the
-- same engine (lib/dup-sweep.ts on top of lib/qbo-dup-scan.ts).
--
-- Tiers: certain  = provable (bank-fed + manual twin, unreconciled, open
--                   period, unlinked) — auto-remove candidate (shadow first)
--        likely   = high-confidence (identical same-day / duplicate doc#)
--        possible = near-duplicates within 3 days — informational
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS dup_findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id   uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  fingerprint      text NOT NULL,      -- kind + sorted txn ids (stable identity)
  kind             text NOT NULL,      -- exact_same_day | near_duplicate | duplicate_doc
  tier             text NOT NULL CHECK (tier IN ('certain','likely','possible')),
  section          text,
  account          text,
  name             text,
  amount           numeric,
  dates            jsonb,
  txn_types        jsonb,
  txn_ids          jsonb,
  doc_numbers      jsonb,
  note             text,
  /** certain-tier evidence: which txn is the removable manual twin */
  remove_candidate jsonb,              -- { txn_id, txn_type, reason }
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept','resolved')),
  resolved_by      uuid REFERENCES users(id),
  resolved_at      timestamptz,
  removed_txn_id   text,
  removed_txn_type text,
  removal_method   text,               -- 'void' | 'delete' | 'restored'
  snapshot         jsonb,              -- full QBO JSON of the removed txn (one-click restore)
  detected_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_link_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_dup_findings_open
  ON dup_findings (client_link_id, detected_at DESC) WHERE status = 'open';
