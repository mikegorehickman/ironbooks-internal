-- Migration 139 — Prior-year cleanup tracking
--
-- Clients must be cleaned up back to the year after their last FILED (closed)
-- tax year. When that's more than the current year, the extra years are a
-- billable catch-up. This column tracks the workflow per client:
--   { "status": "flagged|quoted|notified|approved|in_progress|done|not_needed",
--     "years": [2022, 2023],          -- the catch-up years being tracked
--     "note": "…",
--     "notified_at": "…",             -- client told (billable)
--     "updated_at": "…", "updated_by": "…" }
-- The "who needs it" list is DERIVED from py_taxes_filed_through_year vs the
-- current year (see lib/prior-year-cleanup.ts); this column holds the manual
-- tracking layered on top. Additive + idempotent.

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS prior_year_cleanup jsonb NOT NULL DEFAULT '{}'::jsonb;
