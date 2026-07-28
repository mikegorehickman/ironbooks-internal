-- Migration 141 — fix transaction-line identity in the recon idempotency ledger
-- and de-duplicate the review queue it broke.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────
-- processed_qbo_lines was created with PRIMARY KEY (client_link_id, qbo_line_id).
-- But QBO's Line.Id is a PER-TRANSACTION ORDINAL, not a global id: across the
-- whole fleet the column holds exactly six distinct values — 1, 2, 3, 5, 6, 7.
-- So the key collapses every transaction's first line onto one row per client.
--
-- Two consequences, both measured in production on 2026-07-28:
--
--   1. The ledger cannot grow. It holds 43 rows despite ~3,600 lines pulled per
--      week, because a 200-row batch insert containing two lines numbered "1"
--      violates the primary key and the WHOLE batch fails.
--
--   2. Idempotency therefore never excludes anything, so every nightly run
--      re-queues the same transactions. daily_review_queue holds 6,452 rows for
--      1,940 distinct (client, transaction, line) triples — 4,512 duplicates.
--      One AT&T charge for $63.02 is in there 737 times.
--
-- That inflated backlog is what made the review queue look unworkable.
--
-- ── WHAT WAS NOT DAMAGED ────────────────────────────────────────────────────
-- No client ledger was double-written. All 225 executed queue rows are distinct
-- (client, transaction, line) triples. Auto-execute requires the line to still
-- be sitting in an uncategorized account, so once a line was written it stopped
-- qualifying — the uncategorized check has been doing idempotency's job by
-- accident. That is the safety net, and it is why this is a cleanup rather than
-- an incident.
--
-- ── ORDER MATTERS ───────────────────────────────────────────────────────────
-- Widen the key BEFORE deduplicating, so any concurrent recon run that lands
-- mid-migration inserts under the correct key.

BEGIN;

-- 1. Widen the identity to include the transaction. The existing 43 rows are all
--    distinct under the wider key, so no data is lost.
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

-- 2. De-duplicate daily_review_queue, keeping ONE row per real transaction line.
--    Preference order:
--      a) a row that was actually actioned (executed/approved/rejected) always
--         wins — never discard a recorded human decision;
--      b) otherwise the most recently created row, so the reviewer sees the
--         freshest AI suggestion and anomaly flags.
CREATE TEMP TABLE _queue_keep ON COMMIT DROP AS
SELECT DISTINCT ON (client_link_id, qbo_transaction_id, qbo_line_id) id
FROM daily_review_queue
ORDER BY
  client_link_id,
  qbo_transaction_id,
  qbo_line_id,
  (decision IS DISTINCT FROM 'pending') DESC,  -- actioned rows first
  created_at DESC;

-- Safety: refuse to proceed if the keep-set is not exactly the distinct count.
DO $$
DECLARE
  keep_n   BIGINT;
  actual_n BIGINT;
BEGIN
  SELECT count(*) INTO keep_n FROM _queue_keep;
  SELECT count(*) INTO actual_n FROM (
    SELECT DISTINCT client_link_id, qbo_transaction_id, qbo_line_id
    FROM daily_review_queue
  ) t;
  IF keep_n <> actual_n THEN
    RAISE EXCEPTION 'Dedup guard failed: keeping % rows but % distinct lines exist', keep_n, actual_n;
  END IF;
END $$;

DELETE FROM daily_review_queue q
WHERE NOT EXISTS (SELECT 1 FROM _queue_keep k WHERE k.id = q.id);

-- 3. Stop it recurring at the database level. A partial unique index (rather
--    than a constraint) so it documents intent without blocking a future
--    deliberate re-queue design.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_review_queue_line
  ON daily_review_queue (client_link_id, qbo_transaction_id, qbo_line_id);

COMMIT;

-- ── VERIFY (run after) ──────────────────────────────────────────────────────
-- Expect: total = distinct = 1,940 (or fewer if rows were actioned since).
--
--   SELECT count(*) AS total,
--          count(DISTINCT (client_link_id, qbo_transaction_id, qbo_line_id)) AS distinct_lines
--   FROM daily_review_queue;
--
-- Expect the primary key to list three columns:
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'processed_qbo_lines'::regclass AND contype = 'p';
