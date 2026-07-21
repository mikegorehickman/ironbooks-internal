-- Migration 137 — Cleanup Sequence per-step status
--
-- Adds a single jsonb column to persist the 8-step Cleanup Sequence state
-- (see lib/cleanup-sequence.ts). Shape:
--   { "steps": { "coa": { "status": "done", "note": "", "at": "...", "by": "..." }, ... } }
-- Steps not present in the object fall back to derived/pending status, so an
-- empty {} (the default) is a valid "nothing marked yet" state.
--
-- Additive + idempotent — safe to run against prod at any time.

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS cleanup_sequence jsonb NOT NULL DEFAULT '{}'::jsonb;
