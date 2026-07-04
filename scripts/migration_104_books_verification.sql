-- migration 104 — Books Reliability Score (verification gate on the monthly close).
-- Adds the verification snapshot to the per-(client, period) close row and a
-- cross-month dismissal-memory table ("this finding is known/acceptable for
-- this client"). Idempotent — safe to run more than once.
--
-- Deploy order: apply this BEFORE merging the feat/books-reliability-score PR
-- (the code selects these columns by name).

ALTER TABLE monthly_rec_runs
  ADD COLUMN IF NOT EXISTS verification          jsonb,
  ADD COLUMN IF NOT EXISTS verification_score    int,
  ADD COLUMN IF NOT EXISTS verification_ran_at   timestamptz,
  ADD COLUMN IF NOT EXISTS verification_override jsonb;

COMMENT ON COLUMN monthly_rec_runs.verification IS
  'Books Reliability verification snapshot: pillars, checks, findings (lib/books-verification.ts). Re-verify overwrites, like checks.';
COMMENT ON COLUMN monthly_rec_runs.verification_override IS
  'Senior override for a below-threshold send: { by, at, reason, score_at_override }.';

CREATE TABLE IF NOT EXISTS verification_dismissals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  check_key       text NOT NULL,
  fingerprint     text NOT NULL,             -- stable finding identity (lib/books-verification.ts fingerprintFor)
  reason          text NOT NULL,
  detail_snapshot jsonb,                     -- the finding as it looked when dismissed (audit)
  dismissed_by    uuid REFERENCES users(id),
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  active          boolean NOT NULL DEFAULT true,
  revoked_by      uuid REFERENCES users(id),
  revoked_at      timestamptz,
  UNIQUE (client_link_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_verification_dismissals_client
  ON verification_dismissals (client_link_id) WHERE active;
