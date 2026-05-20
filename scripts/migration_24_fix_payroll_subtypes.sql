-- Migration 24: fix invalid AccountSubType in master_coa
--
-- Baldwin & Co. Painting and Finishing cleanup failed to create the
-- required "Owner Draw / Salary" account because the master_coa
-- table had it tagged with qbo_account_subtype='PayrollWageExpenses'
-- — a value QBO does NOT accept in its enum. The closest valid
-- Expense subtype is 'PayrollExpenses' (covers wages, salaries,
-- benefits; what QBO documents for staff compensation).
--
-- Affected master COA rows from a prior bad seed:
--   Owner Draw / Salary
--   Operations Manager Salary
--   Admin Team Salaries
--   Sales Team Salaries/Commission
-- (Both US and CA variants — 8 rows total.)
--
-- Idempotent: only updates rows still carrying the bad value.

UPDATE master_coa
SET qbo_account_subtype = 'PayrollExpenses'
WHERE qbo_account_subtype = 'PayrollWageExpenses';

-- Verify — should return 0 rows.
SELECT account_name, jurisdiction, qbo_account_subtype
FROM master_coa
WHERE qbo_account_subtype = 'PayrollWageExpenses';
