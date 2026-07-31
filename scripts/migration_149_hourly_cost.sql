-- Migration 149 — loaded hourly cost per person (cost to serve)
--
-- Tracked hours only become a business number once they're priced. With a
-- loaded hourly cost per person we can compute what each client actually COSTS
-- to serve (their tracked time × the cost of whoever did the work) and compare
-- it to what they pay — the real margin per client, and the evidence behind a
-- pricing or upgrade conversation ("Dominion costs 3× what its tier assumes").
--
-- Per-person because a junior's hour and a senior reviewer's hour are not the
-- same cost, and a client worked mostly by a lead is genuinely more expensive.
-- "Loaded" means salary + payroll costs + overhead, not the raw wage — the
-- number is a planning input, not payroll data.
--
-- NULL inherits DEFAULT_HOURLY_COST_CENTS from lib/time-tracking.ts ($45/h).
-- 0 is valid and means "don't cost this person's time against production"
-- (an owner, say) — it must survive as 0, which is why the app resolves it
-- with ?? rather than ||.
--
-- Stored in CENTS as an integer: money in fractional dollars accumulates
-- rounding error once you multiply by thousands of hours.
--
-- Idempotent — safe to run more than once.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_cost_cents integer;

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_hourly_cost_cents_range
    CHECK (hourly_cost_cents IS NULL OR (hourly_cost_cents >= 0 AND hourly_cost_cents <= 100000000));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN users.hourly_cost_cents IS
  'Loaded hourly cost for this person in CENTS (salary + overhead, not the raw wage). Drives cost-to-serve and margin per client. NULL = app default (DEFAULT_HOURLY_COST_CENTS in lib/time-tracking.ts); 0 = exclude from costing. Migration 149.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
SELECT 'migration_149 applied' AS status,
       count(*) FILTER (WHERE hourly_cost_cents IS NOT NULL) AS people_with_custom_rate,
       count(*) AS active_staff
FROM users
WHERE is_active AND role IN ('admin', 'lead', 'bookkeeper');
