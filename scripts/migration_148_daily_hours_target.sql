-- Migration 148 — daily logging target per person
--
-- The monthly client budget answers "did this client cost more than it should".
-- It says nothing about the other half: is each bookkeeper actually logging a
-- full day? Someone who tracks 90 minutes on a day they worked eight hours
-- makes every client look cheap and the utilization number meaningless — so we
-- need an expected hours-per-day per person and a flag when a worked day comes
-- in under it.
--
-- Per-person, not global: a junior on production full-time and a manager who
-- spends most of the day reviewing have genuinely different expectations.
-- NULL inherits DEFAULT_DAILY_TARGET_MINUTES from lib/time-tracking.ts (6h).
-- 0 means "no target" — the right setting for anyone not doing production work,
-- and it must survive as 0 rather than being coalesced back to the default
-- (the app resolves it with ?? for exactly that reason).
--
-- Only days with SOME logged time are judged. A day with nothing at all is a
-- day off, a sick day, or a holiday — we don't know which, and flagging it as
-- "below target" would turn the report into noise.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_target_minutes integer;

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_daily_target_minutes_range
    CHECK (daily_target_minutes IS NULL OR (daily_target_minutes >= 0 AND daily_target_minutes <= 1440));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN users.daily_target_minutes IS
  'Expected logged minutes per working day for this person. NULL = app default (DEFAULT_DAILY_TARGET_MINUTES in lib/time-tracking.ts); 0 = no target (not doing production). Only days with some logged time are compared. Migration 148.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
SELECT 'migration_148 applied' AS status,
       count(*) FILTER (WHERE daily_target_minutes IS NOT NULL) AS people_with_custom_target,
       count(*) AS active_staff
FROM users
WHERE is_active AND role IN ('admin', 'lead', 'bookkeeper');
