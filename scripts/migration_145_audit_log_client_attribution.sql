-- Migration 145 — give audit_log a real client_link_id, and backfill it.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
-- /admin/audit offers "search all actions by user, client, date, or event type
-- — for compliance review", but audit_log has no client_link_id column. The
-- client id lives inside request_payload JSONB, and only when whichever of the
-- 143 write sites happened to include it.
--
-- Measured 2026-07-28, before this migration:
--   23,211 rows · 7,133 attributable to a client (31%) · 16,078 not (69%)
--
-- So filtering by client silently dropped two thirds of the record — and the
-- part it dropped was the substantive engine work: 2,149 qbo_rename, 1,312
-- qbo_merge, 785 qbo_inactivate, 1,017 auto_dismissed. Every one of those is a
-- real change to a specific client's books. Filter a client, see a short list,
-- conclude little happened. That is the same shape as every other bug found
-- today: a screen that looks plausible because what is missing is invisible.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
-- Adds the column, indexes it, and backfills from three sources in order of
-- directness. Measured recovery, not hoped-for:
--
--   pass 1  request_payload->>'client_link_id'      7,133 rows  (31%)
--   pass 2  job_id → coa_jobs / reclass_jobs       11,156 rows  (→ 79%)
--   pass 3  payload->>'reclass_job_id' → job       ~3,200 rows  (→ ~93%)
--
-- Pass 2 resolved 11,156 of 11,156 rows that carry a job_id — a 100% hit rate,
-- because those events are all job-scoped and the job rows still exist.
--
-- ── WHAT STAYS UNATTRIBUTED, CORRECTLY ──────────────────────────────────────
-- Roughly 1,700 rows, and most of them SHOULD be: master_coa_change (~480) is a
-- global template edit, billing_dunning_cron is fleet-wide, and `stage_start`
-- rows that carry no job reference at all can't be recovered from data we have.
-- Fleet-level events genuinely have no single client, and forcing one on them
-- would be worse than leaving them null.
--
-- ── BUILT FOR INTERNAL QA, NOT YET FOR AN EXTERNAL AUDITOR ──────────────────
-- Deliberately NOT doing yet, but not foreclosed either:
--   * append-only enforcement (no UPDATE/DELETE grants, or a trigger)
--   * retention policy + tamper-evidence (hash chain)
--   * signed export
-- Those need a policy decision before code. Nothing here blocks them: the
-- column is additive, the backfill is idempotent, and no existing row's other
-- fields are modified — so an immutability constraint can be layered on later
-- without a data migration. Adding it NOW would mean the backfill itself
-- couldn't run.

BEGIN;

-- ── The column ──────────────────────────────────────────────────────────────
-- Nullable ON PURPOSE: fleet-level events have no client, and a NOT NULL here
-- would force writers to invent one.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS client_link_id UUID REFERENCES client_links(id) ON DELETE SET NULL;

COMMENT ON COLUMN audit_log.client_link_id IS
  'Which client this action affected. NULL means genuinely fleet-level (a master '
  'COA edit, a cron summary) — not "unknown". Populate via lib/audit.ts rather '
  'than a raw insert, so it cannot be omitted again.';

-- Partial index: the fleet-level NULLs are never filtered on, so they are dead
-- weight in the index.
CREATE INDEX IF NOT EXISTS idx_audit_log_client_occurred
  ON audit_log (client_link_id, occurred_at DESC)
  WHERE client_link_id IS NOT NULL;

-- The other two axes the viewer filters on.
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_occurred ON audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_occurred ON audit_log (event_type, occurred_at DESC);

-- ── Pass 1 — the id is already in the payload (31%) ─────────────────────────
UPDATE audit_log a
SET client_link_id = (a.request_payload ->> 'client_link_id')::uuid
WHERE a.client_link_id IS NULL
  AND a.request_payload ->> 'client_link_id' IS NOT NULL
  -- Guard against a malformed value in free-form JSONB.
  AND (a.request_payload ->> 'client_link_id') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (SELECT 1 FROM client_links c WHERE c.id = (a.request_payload ->> 'client_link_id')::uuid);

-- ── Pass 2 — resolve via the job_id column (→ 79%) ──────────────────────────
UPDATE audit_log a
SET client_link_id = j.client_link_id
FROM coa_jobs j
WHERE a.client_link_id IS NULL AND a.job_id = j.id AND j.client_link_id IS NOT NULL;

UPDATE audit_log a
SET client_link_id = j.client_link_id
FROM reclass_jobs j
WHERE a.client_link_id IS NULL AND a.job_id = j.id AND j.client_link_id IS NOT NULL;

-- ── Pass 3 — reclass events that carry the job in the payload (→ ~93%) ──────
-- reclass_progress, reclass_job_change, reclass_job_created and friends put the
-- job under payload.reclass_job_id rather than the job_id column.
UPDATE audit_log a
SET client_link_id = j.client_link_id
FROM reclass_jobs j
WHERE a.client_link_id IS NULL
  AND (a.request_payload ->> 'reclass_job_id') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND (a.request_payload ->> 'reclass_job_id')::uuid = j.id
  AND j.client_link_id IS NOT NULL;

-- Same shape, for anything that used coa_job_id.
UPDATE audit_log a
SET client_link_id = j.client_link_id
FROM coa_jobs j
WHERE a.client_link_id IS NULL
  AND (a.request_payload ->> 'coa_job_id') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND (a.request_payload ->> 'coa_job_id')::uuid = j.id
  AND j.client_link_id IS NOT NULL;

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- Expect attributed to land near 93% (was 31%).
--
--   SELECT count(*)                                                AS total,
--          count(client_link_id)                                   AS attributed,
--          round(100.0 * count(client_link_id) / count(*), 1)       AS pct
--   FROM audit_log;
--
-- What remains unattributed, and whether that is correct — expect master COA
-- edits and cron summaries, which genuinely have no single client:
--
--   SELECT event_type, count(*)
--   FROM audit_log
--   WHERE client_link_id IS NULL
--   GROUP BY 1 ORDER BY 2 DESC LIMIT 15;
