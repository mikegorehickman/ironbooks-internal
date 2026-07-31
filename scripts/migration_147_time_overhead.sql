-- Migration 147 — overhead time: work that belongs to no single client
--
-- Migration 146 could only record time against a client, so everything else a
-- bookkeeper does was invisible: batch inbox/message work, team meetings and
-- training, fleet-wide sweeps (COA audit, bank rules, month-end), firm admin.
-- That mattered two ways — the day didn't add up, and there was no honest
-- utilization number (client time as a share of the working day).
--
-- The rule we're encoding: time is tracked against a CLIENT when the effort
-- varies per client (answering one client's requests is that client's cost, and
-- should count against their budget even though the inbox page isn't
-- client-scoped — the widget now has a client picker for exactly that), and
-- against a CATEGORY when it doesn't vary per client. Overhead is reported
-- separately and is NEVER counted against any client's monthly budget, so it
-- can't quietly inflate a client's apparent cost-to-serve.
--
-- Shape: client_link_id becomes nullable and gains a sibling `category`; a row
-- is exactly one of the two (CHECK below). Existing rows are all client rows
-- with category NULL, so they satisfy it unchanged. Category values are
-- validated by the API against OVERHEAD_CATEGORIES in lib/time-tracking.ts —
-- the CHECK here is the backstop, and adding a category later means editing
-- that list plus this constraint.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

BEGIN;

-- A client is no longer required...
ALTER TABLE time_entries ALTER COLUMN client_link_id DROP NOT NULL;

-- ...but then a category is.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS category text;

DO $$
BEGIN
  ALTER TABLE time_entries ADD CONSTRAINT time_entries_category_values
    CHECK (category IS NULL OR category IN ('client_comms','internal','fleet','admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Exactly one of the two: client work (client_link_id, no category) or overhead
-- (category, no client). Keeps reporting unambiguous — nothing can be half-way
-- between "counts against a budget" and "doesn't".
DO $$
BEGIN
  ALTER TABLE time_entries ADD CONSTRAINT time_entries_client_xor_category
    CHECK (
      (client_link_id IS NOT NULL AND category IS NULL)
      OR (client_link_id IS NULL AND category IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Overhead rollups for the month (mirrors the client-month index from 146).
CREATE INDEX IF NOT EXISTS idx_time_entries_completed_category
  ON time_entries (category, ended_at)
  WHERE status = 'completed' AND category IS NOT NULL;

COMMENT ON COLUMN time_entries.category IS
  'Overhead bucket when the session belongs to no single client: client_comms | internal | fleet | admin. Mutually exclusive with client_link_id; overhead never counts against a client budget. See OVERHEAD_CATEGORIES in lib/time-tracking.ts. Migration 147.';

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
SELECT 'migration_147 applied' AS status,
       (SELECT count(*) FROM time_entries WHERE client_link_id IS NOT NULL) AS client_entries,
       (SELECT count(*) FROM time_entries WHERE category IS NOT NULL) AS overhead_entries,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'time_entries' AND column_name = 'client_link_id') AS client_now_nullable;
