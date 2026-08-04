-- Migration 155: per-page dwell time inside a tracked work session
--
-- Answers "the 2h14m logged to Tidy Casa — where did it actually go?" Today the
-- only signal is time_entries.source_path: one string, captured once, when Start
-- was clicked. This records each page the bookkeeper sits on WHILE A TIMER IS
-- RUNNING, so a session can be broken down by route.
--
-- SCOPE — deliberately narrow. Rows are only ever written for an active
-- time_entries row. Nothing is recorded when the timer is off, when it's
-- paused, on portal/public pages, or for non-timer roles. This is an
-- attribution tool for billed time, not general staff surveillance, and the
-- schema enforces it: entry_id is NOT NULL, so an orphan page view is
-- unrepresentable.
--
-- ACCURACY. Dwell is a proxy, not a measure — reading one long statement looks
-- idle, tab-flipping looks busy. Two mechanics keep it honest, both borrowed
-- from the timer itself:
--   * last_seen_at only advances on a ~60s ping, so a dead tab caps the row
--     within a minute instead of banking the night (same idea as STALE_MS /
--     finalizeSegment on time_entries).
--   * the widget's existing 10-minute idle auto-pause closes the open view, so
--     a walk-away doesn't accrue.
--
-- RETENTION. 12 months, enforced lazily by the senior-only report endpoint
-- (there is no time-tracking cron). Volume is ~1-2k rows/day firm-wide.
--
-- Safe to re-run: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS time_page_views (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The session this dwell belongs to. CASCADE: discarding a session discards
  -- its breakdown, so a discarded entry can never leave orphan telemetry.
  entry_id        UUID NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Snapshot of the entry's client at the time (NULL for overhead sessions).
  -- Denormalized so month/client rollups don't have to join time_entries.
  client_link_id  UUID REFERENCES client_links(id) ON DELETE SET NULL,
  -- Pathname only — never the query string. Tokens and client-identifying
  -- params have no business in a telemetry table.
  path            TEXT NOT NULL,
  -- UUIDs collapsed to ':id' so routes aggregate: /clients/:id/messages.
  route           TEXT NOT NULL,
  entered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Advances only on a ping; this is what caps an abandoned tab.
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set on a clean close (navigation, pause, complete, tab hidden/unloaded).
  -- NULL means the row is the currently-open page for its session.
  exited_at       TIMESTAMPTZ,
  -- Materialized so reporting is a plain SUM. Always derived from
  -- last_seen_at - entered_at, never from wall clock at read time.
  seconds         INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open page view per session — the writer closes the previous row
-- before opening the next, and this makes a double-open impossible rather than
-- merely unlikely (two tabs on the same running entry would otherwise race).
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_page_views_one_open_per_entry
  ON time_page_views (entry_id)
  WHERE exited_at IS NULL;

-- Session drill-down: "break this entry down by page".
CREATE INDEX IF NOT EXISTS idx_time_page_views_entry
  ON time_page_views (entry_id, entered_at);

-- Month rollups by route, and the retention sweep.
CREATE INDEX IF NOT EXISTS idx_time_page_views_entered
  ON time_page_views (entered_at DESC);

-- "Where did this person's month go" / "where did this client's hours go".
CREATE INDEX IF NOT EXISTS idx_time_page_views_user_entered
  ON time_page_views (user_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_page_views_client_entered
  ON time_page_views (client_link_id, entered_at DESC)
  WHERE client_link_id IS NOT NULL;

-- Same posture as time_entries (migration 146): service-role API routes only,
-- no policies. RLS on with zero policies denies every non-service caller.
ALTER TABLE time_page_views ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE time_page_views IS
  'Per-page dwell inside a running time_entries session. Written only while a timer runs; capped by a ~60s ping so an abandoned tab cannot bank idle time. 12-month retention, swept by /api/time-tracking/report.';
COMMENT ON COLUMN time_page_views.last_seen_at IS
  'Advances only on a ping. seconds is derived from this, not from read-time wall clock, so a dead tab self-caps within ~60s.';
COMMENT ON COLUMN time_page_views.exited_at IS
  'NULL = currently open page for the session. Set on nav, pause, complete, or tab unload.';

SELECT 'migration_155 applied' AS status;
