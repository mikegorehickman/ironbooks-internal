-- Data repair — production clients missing the cleanup_completed_at stamp.
--
-- Context: lifecycle status is DERIVED from signals. A client promoted to
-- production has daily_recon_enabled=true, and promotion is *supposed* to also
-- stamp cleanup_completed_at (the cleanup sign-off marker). Some clients were
-- promoted (daily recon on) without that stamp — e.g. daily recon toggled on
-- directly, or a legacy promotion path. That left them in a contradictory
-- state that the lifecycle couldn't represent, so production-board actions
-- (Waiting on client / Ready for review / Close) had no visible effect.
--
-- The code fix (fix/lifecycle-production-transitions) already keys "production"
-- off daily_recon_enabled ALONE, so these clients render correctly without this
-- repair. This backfill is data hygiene: it makes cleanup_completed_at
-- consistent with reality (a live client HAS completed cleanup) so the
-- "Completed accounts" partition and any cleanup-phase query agree.
--
-- Safe + idempotent: only touches active, daily-recon-ON clients whose stamp is
-- NULL, and uses the recorded promotion time (daily_recon_enabled_at) when
-- available, else now().

UPDATE client_links
SET cleanup_completed_at = COALESCE(daily_recon_enabled_at, now())
WHERE is_active = true
  AND daily_recon_enabled = true
  AND cleanup_completed_at IS NULL;

-- Verify (expect 0 rows after running):
-- SELECT client_name FROM client_links
-- WHERE is_active AND daily_recon_enabled AND cleanup_completed_at IS NULL;
