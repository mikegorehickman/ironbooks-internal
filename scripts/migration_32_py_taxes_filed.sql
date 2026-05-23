-- ============================================================================
-- Migration 32: Prior-year taxes filed (one-time client setting)
-- ============================================================================
-- Records whether the client has filed their prior-year taxes and through
-- which year. Used downstream to:
--   - Default reclass date ranges to "current year only" so we don't touch
--     books that are already filed
--   - Warn (or block) when a bookkeeper picks a date range that overlaps
--     a filed year
--   - Surface as an indicator on the client card / kanban
--
-- Set once on client onboarding, editable from the client card.
-- ============================================================================

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS py_taxes_filed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS py_taxes_filed_through_year INTEGER,
  ADD COLUMN IF NOT EXISTS py_taxes_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS py_taxes_updated_by UUID REFERENCES users(id);

COMMENT ON COLUMN client_links.py_taxes_filed IS
  'When true, the client has filed taxes through py_taxes_filed_through_year. Used to scope reclass jobs to unfiled periods.';
COMMENT ON COLUMN client_links.py_taxes_filed_through_year IS
  'The latest calendar (or fiscal) year that has been filed. e.g. 2024 means everything up to and including 2024 is locked.';
