-- Migration 141 — fix transaction-line identity in the recon idempotency ledger
-- and de-duplicate the review queue it broke.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────
-- processed_qbo_lines was created with PRIMARY KEY (client_link_id, qbo_line_id).
-- But QBO's Line.Id is a PER-TRANSACTION ORDINAL, not a global id: the ledger
-- holds only 5 distinct values. So the key collapses every transaction's first
-- line onto one row per client.
--
-- Measured in production 2026-07-28:
--   * the ledger holds 43 rows despite ~3,600 lines pulled per week, because a
--     200-row batch containing two lines numbered "1" violates the key and the
--     WHOLE batch fails (its error was never checked, so it failed silently);
--   * idempotency therefore excludes nothing, so every nightly run re-queues the
--     same transactions: 6,452 queue rows for 1,940 distinct
--     (client, transaction, line) triples — 4,512 duplicates. One AT&T charge for
--     $63.02 is in there 737 times.
--
-- ── WHAT WAS NOT DAMAGED ────────────────────────────────────────────────────
-- No client ledger was double-written. All 225 executed queue rows are distinct
-- triples. Auto-execute requires the line to still be sitting in an uncategorized
-- account, so once written a line stopped qualifying — the uncategorized check has
-- been doing idempotency's job by accident.
--
-- ── WHY NO TEMP TABLE ───────────────────────────────────────────────────────
-- An earlier draft staged the keep-set in a TEMP TABLE. That fails in the Supabase
-- SQL editor: statements run over a pooled connection, so `ON COMMIT DROP` drops
-- the table before the next statement sees it ("relation _queue_keep does not
-- exist"). Every step below is a SINGLE self-contained statement, safe to run one
-- at a time and safe to re-run.

-- ── STEP 1 — widen the identity (idempotent) ────────────────────────────────
ALTER TABLE processed_qbo_lines
  DROP CONSTRAINT IF EXISTS processed_qbo_lines_pkey;

ALTER TABLE processed_qbo_lines
  ADD CONSTRAINT processed_qbo_lines_pkey
  PRIMARY KEY (client_link_id, qbo_transaction_id, qbo_line_id);

COMMENT ON TABLE processed_qbo_lines IS
  'Idempotency table. Keyed on (client_link_id, qbo_transaction_id, qbo_line_id) — '
  'qbo_line_id ALONE IS NOT UNIQUE: QBO Line.Id is a per-transaction ordinal '
  '(1, 2, 3...). Keying on it without the transaction id collapsed the whole '
  'ledger to 43 rows and broke idempotency fleet-wide (fixed 2026-07-28).';

-- ── STEP 2 — de-duplicate the queue, in ONE statement ───────────────────────
-- Keeps exactly one row per real transaction line. Preference:
--   a) a row a human actioned always wins — never discard a recorded decision;
--   b) otherwise the most recent, so the reviewer sees the freshest suggestion.
WITH keep AS (
  SELECT DISTINCT ON (client_link_id, qbo_transaction_id, qbo_line_id) id
  FROM daily_review_queue
  ORDER BY
    client_link_id,
    qbo_transaction_id,
    qbo_line_id,
    (decision IS DISTINCT FROM 'pending') DESC,
    created_at DESC
)
DELETE FROM daily_review_queue q
WHERE NOT EXISTS (SELECT 1 FROM keep k WHERE k.id = q.id);

-- ── STEP 3 — stop it recurring ──────────────────────────────────────────────
-- This IS the guard: if step 2 left a duplicate behind, this fails and nothing
-- downstream can silently re-duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_review_queue_line
  ON daily_review_queue (client_link_id, qbo_transaction_id, qbo_line_id);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT count(*) AS total,
--          count(DISTINCT (client_link_id, qbo_transaction_id, qbo_line_id)) AS distinct_lines,
--          count(*) FILTER (WHERE decision IS DISTINCT FROM 'pending') AS actioned
--   FROM daily_review_queue;
--   -- expect 1940 / 1940 / 225
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'processed_qbo_lines'::regclass AND contype = 'p';
--   -- expect three columns in the key
