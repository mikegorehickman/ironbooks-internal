-- Migration 46: external_invoice_id on hardcore_cleanup_crm_jobs
--
-- Context:
--   The hardcore-cleanup matcher only compared CRM jobs to QBO by
--   (customer_name + amount + date). It never checked the CRM's own
--   Invoice ID against QBO's DocNumber, even though both DripJobs and
--   Jobber push that ID through to QBO on sync.
--
--   Brady Brown / Clean Cut Painters caught this: DripJobs Invoice IDs
--   273312 and 360547 land in QBO as DocNumber #273312 and #360547
--   verbatim. The matcher was flagging both proposals as "no deposit
--   found" false positives — burying the one truly missing proposal
--   (DripJobs Invoice ID 346549, no QBO sibling, $35,609.24).
--
--   This migration adds the column so the parser can persist the CRM's
--   stable invoice id alongside crm_job_id (which is the lineage key
--   for change orders). reconcileCrmAgainstQbo now does a DocNumber
--   lookup as its first match pass.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.

ALTER TABLE hardcore_cleanup_crm_jobs
  ADD COLUMN IF NOT EXISTS external_invoice_id TEXT;

COMMENT ON COLUMN hardcore_cleanup_crm_jobs.external_invoice_id IS
  'The CRM''s INVOICE id, distinct from crm_job_id. For DripJobs, the "Invoice ID" column (becomes QBO DocNumber on sync). For Jobber, the Invoice # / Job # (same as crm_job_id). Used by reconcileCrmAgainstQbo for direct DocNumber lookup against QBO.';

-- Index supports the engine's DocNumber lookup pass — keyed by run +
-- normalized invoice id so a single run's CRM-job-to-QBO-doc match runs
-- in O(crm_jobs) instead of O(crm_jobs × qbo_invoices).
CREATE INDEX IF NOT EXISTS hardcore_cleanup_crm_jobs_external_invoice_id_idx
  ON hardcore_cleanup_crm_jobs (run_id, external_invoice_id)
  WHERE external_invoice_id IS NOT NULL;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'hardcore_cleanup_crm_jobs'
  AND column_name = 'external_invoice_id';
