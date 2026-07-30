-- Migration 146 — time_entries: bookkeeper time tracking
--
-- The team has never known what a client actually costs in hours. Bookkeepers
-- work an account (cleanup, daily recon, month-end) with no record of the time
-- spent, so there is no way to compare "how long this client takes" against
-- "how long it should" — or to catch the client that quietly eats a whole
-- afternoon every month. This adds the one table behind the floating timer
-- widget: a bookkeeper opens a client page, clicks Start, and the session is
-- recorded; each client carries a MONTHLY time budget (minutes), and completing
-- a session while the client's month is over budget requires a written reason.
--
-- Design notes:
--   - One row per work SESSION (start → complete), not per day. Elapsed time
--     is accumulated_seconds plus the live segment since last_resumed_at; every
--     pause banks the running segment into accumulated_seconds. There is no
--     separate total column — after the completing fold, accumulated_seconds IS
--     the total (one source of truth, nothing to drift).
--   - Statuses are text + CHECK (house convention, never enums):
--     running → paused → running … → completed, or → discarded (an accidental
--     start; kept for audit, excluded from every report — no deletes).
--   - ONE RUNNING entry per user, enforced by a partial unique index — the app
--     auto-pauses the old timer when a new one starts, so paused entries may
--     accumulate (they're listed in the widget; the report flags stale ones).
--   - last_heartbeat_at is bumped every ~60s by the widget while running. A
--     running entry whose heartbeat is >30 min old is treated as abandoned:
--     every write path and the lazy sweep cap its segment AT the last heartbeat
--     and auto-pause it (auto_paused = true) — a dead laptop can never credit a
--     night of wall-clock time, and nothing is ever silently completed.
--   - Month attribution = ended_at (in the business timezone, America/Regina —
--     see lib/time-tracking.ts). A reviewed month can never change after the
--     fact, because no entry can complete INTO a past month.
--   - budget/mtd snapshots at completion preserve each over-budget note's
--     context ("190m of a 180m budget") even if the budget is edited later.
--   - Deliberately NOT per-month budgets (v2 if needed): one monthly budget per
--     client, time_budget_minutes on client_links, NULL → app default (120).
--     0 is a valid budget ("always explain time on this client").
--
-- Accessed via service-role API routes only (app/api/time-tracking/*); RLS is
-- enabled with zero policies so `authenticated` (portal clients) can never read
-- staff time. Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

CREATE TABLE IF NOT EXISTS time_entries (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id                uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  user_id                       uuid NOT NULL REFERENCES users(id),
  status                        text NOT NULL DEFAULT 'running'
                                  CHECK (status IN ('running','paused','completed','discarded')),
  started_at                    timestamptz NOT NULL DEFAULT now(),
  -- Set iff running: the moment the CURRENT segment began (start or last resume).
  last_resumed_at               timestamptz,
  -- Active seconds banked at each pause; after complete, this is the total.
  accumulated_seconds           integer NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
  -- Month-attribution key; set on complete/discard.
  ended_at                      timestamptz,
  -- Page the timer was started from ("/clients/<id>", "/today/<id>", ...).
  source_path                   text,
  -- Required (by the API) when the client's month was over budget at completion.
  over_budget_note              text,
  -- Snapshots taken at every completion so notes keep their context ("190m of
  -- a 180m budget") even if the budget is edited later.
  budget_minutes_at_completion  integer,
  mtd_seconds_at_completion     integer,
  -- True when the stale sweep (not the user) paused it; cleared on resume.
  auto_paused                   boolean NOT NULL DEFAULT false,
  -- Bumped ~60s by the widget while running; the stale-cap anchor.
  last_heartbeat_at             timestamptz NOT NULL DEFAULT now(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  -- Running ⟺ an open segment exists. Keeps every writer honest.
  CHECK ((status = 'running') = (last_resumed_at IS NOT NULL)),
  -- Terminal rows always know when they ended (month attribution needs it).
  CHECK (status NOT IN ('completed','discarded') OR ended_at IS NOT NULL)
);

-- One RUNNING timer per user (paused entries may accumulate — deliberate;
-- the "start B while A runs" flow auto-pauses A first, which this allows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_running_per_user
  ON time_entries (user_id) WHERE status = 'running';
-- The widget's "my active entries" lookup.
CREATE INDEX IF NOT EXISTS idx_time_entries_active_by_user
  ON time_entries (user_id) WHERE status IN ('running','paused');
-- The over-budget MTD check: this client's completed time in a month range.
CREATE INDEX IF NOT EXISTS idx_time_entries_completed_client_month
  ON time_entries (client_link_id, ended_at) WHERE status = 'completed';
-- The report's whole-fleet month scan.
CREATE INDEX IF NOT EXISTS idx_time_entries_completed_month
  ON time_entries (ended_at) WHERE status = 'completed';

-- Per-client monthly budget in minutes. NULL → the app default
-- (DEFAULT_TIME_BUDGET_MINUTES in lib/time-tracking.ts). 0 is valid and means
-- "any time on this client needs an explanation".
ALTER TABLE client_links ADD COLUMN IF NOT EXISTS time_budget_minutes integer;

-- Service-role only: reads and writes go through the time-tracking API routes.
-- No policies for `authenticated`, so portal clients can never see staff time.
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE time_entries IS
  'Bookkeeper work sessions per client (floating timer widget). One row per start→complete session; accumulated_seconds is the single source of truth after completion; month attribution by ended_at in America/Regina. See lib/time-tracking.ts. Migration 146.';
COMMENT ON COLUMN time_entries.accumulated_seconds IS
  'Active seconds banked at each pause; equals the session total once completed. Migration 146.';
COMMENT ON COLUMN time_entries.over_budget_note IS
  'Required by the API when the client month-to-date (incl. this session) exceeded the budget at completion. Migration 146.';
COMMENT ON COLUMN time_entries.auto_paused IS
  'Paused by the stale sweep (heartbeat >30 min old), not the user; segment capped at last_heartbeat_at. Cleared on resume. Migration 146.';
COMMENT ON COLUMN client_links.time_budget_minutes IS
  'Monthly bookkeeper time budget for this client, minutes. NULL = app default (lib/time-tracking.ts); 0 = always require an explanation. Migration 146.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
SELECT 'migration_146 applied' AS status,
       (SELECT count(*) FROM time_entries) AS time_entries_rows,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_name = 'client_links' AND column_name = 'time_budget_minutes') AS budget_col;
