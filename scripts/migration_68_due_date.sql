-- Migration 68: cleanup deadline on client_links
-- The Cleanup board's assignment editor saves due_date via
-- PATCH /api/clients/[id]; the column was never created, so saves
-- 500'd silently. Date-only — deadlines are day-granular.
ALTER TABLE client_links ADD COLUMN IF NOT EXISTS due_date date;
