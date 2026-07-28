-- Migration 143: opt-in flag for the merge JE sweep
-- ==================================================
-- A COA merge line-reclassifies the real transactions (Bill / Purchase /
-- Expense / VendorCredit) onto the target so the target's drill-down shows
-- actual transactions. Whatever line-reclass can't move — income, deposits,
-- paycheques, existing JEs — used to be swept with per-month reclassifying
-- journal entries.
--
-- That sweep moves the money but COLLAPSES the transaction detail, which is
-- what wrecked GL detail on nine accounts across the fleet. As of 2026-07-26
-- it is OFF by default: an account with unmovable residue keeps its activity,
-- stays ACTIVE, and is reported for a native merge in the QuickBooks UI (the
-- only path that moves income/payroll with detail intact — the API has no
-- merge endpoint).
--
-- This column re-enables the old behavior for a single job, deliberately.
-- Absent column reads as false in the executor, so applying this is optional
-- for the no-JE policy to take effect.
--
-- Idempotent — safe to run more than once.

ALTER TABLE coa_jobs
  ADD COLUMN IF NOT EXISTS allow_je_sweep boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN coa_jobs.allow_je_sweep IS
  'Opt in to the balance-JE sweep for merge residue that line-reclass cannot move. Default false: prefer a native QBO-UI merge so transaction detail survives.';
