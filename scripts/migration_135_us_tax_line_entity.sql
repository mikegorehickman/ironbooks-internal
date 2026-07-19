-- Migration 135 — US tax-line mapping + per-client entity type (Mike 2026-07-18)
--
-- The US analog to GIFI. There's no single government code index in the US, so
-- each account maps to its IRS return line (the same concept tax software calls
-- "tax-line mapping"). Trades-specific account NAMES stay client-facing; the
-- us_tax_line is metadata pulled only by the tax export.
--
-- entity_type on client_links is the authoritative tax classification
-- (c_corp / s_corp / partnership / sole_prop). It drives which form applies
-- (US: 1120 / 1120-S / 1065 / Schedule C — CA: T2 vs T2125) and the
-- owner-equity codes. Backfilled from the existing free-text corporate_type;
-- editable by admin/lead via the profile toggle. Additive + idempotent.

ALTER TABLE master_coa   ADD COLUMN IF NOT EXISTS us_tax_line  text;
ALTER TABLE client_links ADD COLUMN IF NOT EXISTS entity_type  text;

-- ── entity_type backfill from corporate_type (only where still null) ──
UPDATE client_links SET entity_type = 's_corp'
  WHERE entity_type IS NULL AND corporate_type ~* 's[-_ ]?corp';
UPDATE client_links SET entity_type = 'partnership'
  WHERE entity_type IS NULL AND corporate_type ~* 'partnership';
UPDATE client_links SET entity_type = 'sole_prop'
  WHERE entity_type IS NULL AND corporate_type ~* 'sole|proprietor';
UPDATE client_links SET entity_type = 'c_corp'
  WHERE entity_type IS NULL AND corporate_type ~* 'corp|corporation|inc\b|ltd|limited';
-- (LLC / blank left NULL on purpose — ambiguous; bookkeeper sets it explicitly.)

-- ── us_tax_line seed (US master_coa only; canonical IRS line per account) ──
UPDATE master_coa SET us_tax_line = 'Gross receipts or sales' WHERE jurisdiction = 'US' AND account_name = 'Service Revenue';
UPDATE master_coa SET us_tax_line = 'Gross receipts or sales' WHERE jurisdiction = 'US' AND account_name = 'Remodeling Revenue';
UPDATE master_coa SET us_tax_line = 'Returns and allowances' WHERE jurisdiction = 'US' AND account_name = 'Discounts';
UPDATE master_coa SET us_tax_line = 'COGS – Cost of labor' WHERE jurisdiction = 'US' AND account_name = 'Job Costs - Labor';
UPDATE master_coa SET us_tax_line = 'COGS – Cost of labor' WHERE jurisdiction = 'US' AND account_name = 'Direct Field Labor';
UPDATE master_coa SET us_tax_line = 'COGS – Cost of labor' WHERE jurisdiction = 'US' AND account_name = 'Employer Payroll Taxes – Field';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Workers Compensation – Field';
UPDATE master_coa SET us_tax_line = 'COGS – Purchases' WHERE jurisdiction = 'US' AND account_name = 'Job Supplies & Materials';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Small Tools';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Job Costs - Other';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Equipment Rental (Job-Specific)';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Subcontractors';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Job Disposal Fees';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Permit Fees';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Direct Fuel Allocation';
UPDATE master_coa SET us_tax_line = 'COGS – Cost of labor' WHERE jurisdiction = 'US' AND account_name = 'Owner Labor (COGS)';
UPDATE master_coa SET us_tax_line = 'COGS – Other costs' WHERE jurisdiction = 'US' AND account_name = 'Uniforms';
UPDATE master_coa SET us_tax_line = 'Salaries and wages' WHERE jurisdiction = 'US' AND account_name = 'Payroll';
UPDATE master_coa SET us_tax_line = 'Compensation of officers' WHERE jurisdiction = 'US' AND account_name = 'Owner''s Payroll';
UPDATE master_coa SET us_tax_line = 'Salaries and wages' WHERE jurisdiction = 'US' AND account_name = 'Operations Manager Payroll';
UPDATE master_coa SET us_tax_line = 'Salaries and wages' WHERE jurisdiction = 'US' AND account_name = 'Admin Team Payroll';
UPDATE master_coa SET us_tax_line = 'Salaries and wages' WHERE jurisdiction = 'US' AND account_name = 'Sales Team Payroll/Commission';
UPDATE master_coa SET us_tax_line = 'Salaries and wages' WHERE jurisdiction = 'US' AND account_name = 'Payroll Expenses';
UPDATE master_coa SET us_tax_line = 'Taxes and licenses' WHERE jurisdiction = 'US' AND account_name = 'Employer Payroll Taxes – Admin & Sales';
UPDATE master_coa SET us_tax_line = 'Employee benefit programs' WHERE jurisdiction = 'US' AND account_name = 'Employee Benefits – Admin & Sales';
UPDATE master_coa SET us_tax_line = 'Pension, profit-sharing plans' WHERE jurisdiction = 'US' AND account_name = 'Retirement Contributions – Owner';
UPDATE master_coa SET us_tax_line = 'Advertising' WHERE jurisdiction = 'US' AND account_name = 'Marketing';
UPDATE master_coa SET us_tax_line = 'Advertising' WHERE jurisdiction = 'US' AND account_name = 'Online Advertising - Ad Spend';
UPDATE master_coa SET us_tax_line = 'Advertising' WHERE jurisdiction = 'US' AND account_name = 'Trade Shows / Industry Events';
UPDATE master_coa SET us_tax_line = 'Advertising' WHERE jurisdiction = 'US' AND account_name = 'Marketing Tools';
UPDATE master_coa SET us_tax_line = 'Advertising' WHERE jurisdiction = 'US' AND account_name = 'Networking Events';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Vehicle Expenses';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Vehicle Lease';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Vehicle Repairs';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Fuel – Overhead';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Vehicle Insurance';
UPDATE master_coa SET us_tax_line = 'Interest expense' WHERE jurisdiction = 'US' AND account_name = 'Vehicle Loan Interest';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Parking';
UPDATE master_coa SET us_tax_line = 'Car and truck expenses' WHERE jurisdiction = 'US' AND account_name = 'Tolls';
UPDATE master_coa SET us_tax_line = 'Insurance (other than health)' WHERE jurisdiction = 'US' AND account_name = 'Insurance';
UPDATE master_coa SET us_tax_line = 'Insurance (other than health)' WHERE jurisdiction = 'US' AND account_name = 'CGL Insurance';
UPDATE master_coa SET us_tax_line = 'Insurance (other than health)' WHERE jurisdiction = 'US' AND account_name = 'Workers Compensation – Admin';
UPDATE master_coa SET us_tax_line = 'Insurance (other than health)' WHERE jurisdiction = 'US' AND account_name = 'Insurance – Other';
UPDATE master_coa SET us_tax_line = 'Employee benefit programs' WHERE jurisdiction = 'US' AND account_name = 'Health Insurance – Owner';
UPDATE master_coa SET us_tax_line = 'Legal and professional services' WHERE jurisdiction = 'US' AND account_name = 'Professional Fees';
UPDATE master_coa SET us_tax_line = 'Legal and professional services' WHERE jurisdiction = 'US' AND account_name = 'Accounting & Bookkeeping';
UPDATE master_coa SET us_tax_line = 'Legal and professional services' WHERE jurisdiction = 'US' AND account_name = 'Legal Fees';
UPDATE master_coa SET us_tax_line = 'Other deductions' WHERE jurisdiction = 'US' AND account_name = 'Bank Charges';
UPDATE master_coa SET us_tax_line = 'Office expense' WHERE jurisdiction = 'US' AND account_name = 'Office & Admin';
UPDATE master_coa SET us_tax_line = 'Rents' WHERE jurisdiction = 'US' AND account_name = 'Office Rent';
UPDATE master_coa SET us_tax_line = 'Office expense' WHERE jurisdiction = 'US' AND account_name = 'Office Supplies';
UPDATE master_coa SET us_tax_line = 'Utilities' WHERE jurisdiction = 'US' AND account_name = 'Utilities';
UPDATE master_coa SET us_tax_line = 'Office expense' WHERE jurisdiction = 'US' AND account_name = 'Postage & Delivery';
UPDATE master_coa SET us_tax_line = 'Other deductions' WHERE jurisdiction = 'US' AND account_name = 'Software Subscriptions';
UPDATE master_coa SET us_tax_line = 'Other deductions' WHERE jurisdiction = 'US' AND account_name = 'Continuing Education / Professional Development';
UPDATE master_coa SET us_tax_line = 'Interest expense' WHERE jurisdiction = 'US' AND account_name = 'Financial';
UPDATE master_coa SET us_tax_line = 'Interest expense' WHERE jurisdiction = 'US' AND account_name = 'Interest Expense';
UPDATE master_coa SET us_tax_line = 'Depreciation' WHERE jurisdiction = 'US' AND account_name = 'Depreciation';
UPDATE master_coa SET us_tax_line = 'Travel' WHERE jurisdiction = 'US' AND account_name = 'Travel & Meals';
UPDATE master_coa SET us_tax_line = 'Travel' WHERE jurisdiction = 'US' AND account_name = 'Travel – Airfare & Lodging';
UPDATE master_coa SET us_tax_line = 'Meals (50% limit)' WHERE jurisdiction = 'US' AND account_name = 'Meals (50% deductible)';
UPDATE master_coa SET us_tax_line = 'Taxes and licenses' WHERE jurisdiction = 'US' AND account_name = 'Taxes';
UPDATE master_coa SET us_tax_line = 'Taxes and licenses' WHERE jurisdiction = 'US' AND account_name = 'Registration';
UPDATE master_coa SET us_tax_line = 'Taxes and licenses' WHERE jurisdiction = 'US' AND account_name = 'Licenses';
UPDATE master_coa SET us_tax_line = 'Taxes and licenses' WHERE jurisdiction = 'US' AND account_name = 'Property Taxes';
UPDATE master_coa SET us_tax_line = 'Other deductions' WHERE jurisdiction = 'US' AND account_name = 'Gifts';
UPDATE master_coa SET us_tax_line = 'Other deductions — NON-DEDUCTIBLE' WHERE jurisdiction = 'US' AND account_name = 'Penalties & Fines';
UPDATE master_coa SET us_tax_line = 'Other deductions' WHERE jurisdiction = 'US' AND account_name = 'Uncategorized Expenses';
UPDATE master_coa SET us_tax_line = 'Other deductions' WHERE jurisdiction = 'US' AND account_name = 'Recruiting';
UPDATE master_coa SET us_tax_line = 'Charitable contributions' WHERE jurisdiction = 'US' AND account_name = 'Charitable Giving';
UPDATE master_coa SET us_tax_line = 'Charitable contributions' WHERE jurisdiction = 'US' AND account_name = 'Donations';
UPDATE master_coa SET us_tax_line = 'Bad debts' WHERE jurisdiction = 'US' AND account_name = 'Bad Debt Expense';
UPDATE master_coa SET us_tax_line = 'Depreciable assets' WHERE jurisdiction = 'US' AND account_name = 'Computer Equipment';
UPDATE master_coa SET us_tax_line = 'Depreciable assets' WHERE jurisdiction = 'US' AND account_name = 'Office Equipment';
UPDATE master_coa SET us_tax_line = 'Depreciable assets' WHERE jurisdiction = 'US' AND account_name = 'Equipment';
UPDATE master_coa SET us_tax_line = 'Organizational / startup costs' WHERE jurisdiction = 'US' AND account_name = 'Incorporation Costs';
UPDATE master_coa SET us_tax_line = 'Distributions / Owner''s draw (equity)' WHERE jurisdiction = 'US' AND account_name = 'Owner''s Draw';
UPDATE master_coa SET us_tax_line = 'Paid-in capital / Owner''s equity' WHERE jurisdiction = 'US' AND account_name = 'Owner Contributions';
UPDATE master_coa SET us_tax_line = 'Interest income' WHERE jurisdiction = 'US' AND account_name = 'Interest Income';
