-- Migration 12: Unique constraint on (client_link_id, vendor_pattern) for bank_rules
--
-- The /api/rules/from-reclass endpoint and the reclass web-search cache both
-- use ON CONFLICT(client_link_id, vendor_pattern) to upsert rules. The
-- constraint was never created, so the upsert errors out with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- One vendor pattern per client → one rule. Same pattern across different
-- clients is allowed (different client COAs, different target accounts).
--
-- Dedupe any existing duplicates before adding the constraint so the ALTER
-- doesn't fail on legacy data.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY client_link_id, vendor_pattern
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM bank_rules
)
DELETE FROM bank_rules
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

ALTER TABLE bank_rules
  ADD CONSTRAINT bank_rules_client_vendor_unique
  UNIQUE (client_link_id, vendor_pattern);

-- Verify:
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'bank_rules'::regclass
  AND contype = 'u';
