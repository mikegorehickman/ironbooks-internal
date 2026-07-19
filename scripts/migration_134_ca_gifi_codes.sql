-- Migration 134 — complete + correct the Canadian GIFI mapping (Mike 2026-07-18)
-- Keep the trades-specific account names on every client P&L/statement; the
-- GIFI code is metadata pulled ONLY by the T2/GIFI tax export (never rendered
-- client-facing). This fills the 6 accounts that had no code and fixes 2 that
-- the migration-109 name-seed got wrong. Validated against CRA RC4088.
--
-- Updated by account_name (both jurisdictions where the name exists) on
-- purpose: the codes are valid GIFI, harmless on US rows (US never files
-- GIFI), and this also closes a latent bug — lib/tax-export.ts keys its GIFI
-- lookup by account_name alone, so a stale US code on a shared name could
-- otherwise resurface. Idempotent: re-running sets the same values.

-- ── Corrections (seed code was wrong) ──
-- 8457 = "Freight-in and duty", NOT equipment rental. Job-specific rental →
-- Other direct costs (cost of sales).
UPDATE master_coa SET gifi_code = '8450' WHERE account_name = 'Equipment Rental (Job-Specific)';
-- 8620 = "Employee benefits", NOT commissions. Commissions → 9061.
UPDATE master_coa SET gifi_code = '9061' WHERE account_name = 'Sales Team Payroll/Commission';

-- ── Newly mapped (were NULL) ──
UPDATE master_coa SET gifi_code = '2680' WHERE account_name = 'GST/HST Payable';            -- Taxes payable
UPDATE master_coa SET gifi_code = '2680' WHERE account_name = 'PST Payable';                -- Taxes payable
UPDATE master_coa SET gifi_code = '1483' WHERE account_name = 'GST/HST Recoverable (ITCs)'; -- Taxes recoverable/refundable
UPDATE master_coa SET gifi_code = '8710' WHERE account_name = 'Non-Deductible Interest (CRA)'; -- Interest & bank charges (add back on Sch 1)
UPDATE master_coa SET gifi_code = '9270' WHERE account_name = 'Penalties & Fines';          -- Other expenses (non-deductible)
UPDATE master_coa SET gifi_code = '9270' WHERE account_name = 'Uncategorized Expenses';     -- Other expenses (placeholder)

-- ── Owner equity — corp / shareholder-loan model (Mike 2026-07-18) ──
-- Was 3660 (= opening Retained Earnings, wrong). Incorporated painters run
-- owner money in/out through the shareholder loan, so both map to 2781
-- (Due to individual shareholder(s)) — draws debit it, contributions credit it.
UPDATE master_coa SET gifi_code = '2781' WHERE account_name = 'Owner''s Draw';
UPDATE master_coa SET gifi_code = '2781' WHERE account_name = 'Owner Contributions';
