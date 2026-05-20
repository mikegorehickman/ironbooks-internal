-- Migration 30: add `web_search_paused` to job_status enum
--
-- The reclass discovery worker writes status='web_search_paused' when the
-- AI categorization is complete but some vendors had low confidence and the
-- bookkeeper needs to choose whether to invoke web search or skip it. The
-- TS code (discover/route.ts, web-search-chunk/route.ts, skip-web-search,
-- review/page.tsx, discovery-pending.tsx) was already referencing this
-- value, but the Postgres enum was never extended — so the final status
-- update threw `invalid input value for enum job_status: "web_search_paused"`
-- and left the job stuck in `executing` (or wherever it was prior).
--
-- Clean Cut Painters LLC hit this on 2026-05-20. Fix applied to prod via
-- one-off ALTER on the same day; this file commits it for fresh DBs,
-- staging, and any future restores.
--
-- ADD VALUE cannot run inside a transaction block — execute this file
-- as a standalone statement (not wrapped in BEGIN/COMMIT).

ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'web_search_paused';
