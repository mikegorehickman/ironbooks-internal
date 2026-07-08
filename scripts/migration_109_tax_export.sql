-- migration 109 — Canadian tax export (GIFI / T2125 / T5018).
-- 1. gifi_code on master_coa: ONE mapping drives both the T2 GIFI export
--    (ProFile / TaxPrep / CanTax / TaxCycle all import GIFI) and the T2125
--    sheet (its expense lines use the same code system). Seeded below by
--    account name; editable on the Tax Exports page.
-- 2. tax_jurisdiction_notes: cached per (jurisdiction, fiscal_year) AI
--    research notes sourced ONLY from government websites.
-- Idempotent — safe to run more than once.

ALTER TABLE master_coa ADD COLUMN IF NOT EXISTS gifi_code text;

CREATE TABLE IF NOT EXISTS tax_jurisdiction_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction text NOT NULL,
  region       text,                -- province/state ('' = federal only)
  fiscal_year  int NOT NULL,
  notes        jsonb NOT NULL,      -- [{title, detail, source_url, applies_to}]
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jurisdiction, region, fiscal_year)
);

-- ── GIFI seed by account name (both jurisdictions; GIFI is used for CA
--    filings, and the same codes drive the T2125 grouping). Only fills
--    NULLs so hand-edits are never clobbered. ──
UPDATE master_coa SET gifi_code = c.code FROM (VALUES
  ('Painting Revenue','8000'), ('Remodeling Revenue','8000'),
  ('Interest Income','8090'),
  ('Direct Field Labor – Painting','8340'), ('Direct Field Labor - Painting','8340'),
  ('Employer CPP & EI Contributions – Field','8340'), ('Employer CPP & EI Contributions - Field','8340'),
  ('Owner Labor (COGS)','8340'),
  ('Paint & Materials','8320'), ('Job Supplies','8320'), ('Small Tools','8320'),
  ('Subcontractors – Painting','8360'), ('Subcontractors - Painting','8360'),
  ('Equipment Rental (Job-Specific)','8457'),
  ('Job Disposal Fees','8450'), ('Permit Fees','8450'), ('Direct Fuel Allocation','8450'),
  ('Workers Compensation – Field','8450'), ('Workers Compensation - Field','8450'),
  ('Workman''s Comp Insurance','8450'), ('Uniforms','8450'),
  ('Job Costs - Labor','8340'), ('Job Costs - Materials & Supplies','8320'), ('Job Costs - Other','8450'),
  ('Online Advertising – Google Ads / Social Media Marketing','8521'),
  ('Online Advertising - Google Ads / Social Media Marketing','8521'),
  ('Trade Shows / Industry Events','8521'), ('Marketing Tools','8521'), ('Networking Events','8521'), ('Marketing','8521'),
  ('Owner''s Payroll','9060'), ('Admin Team Payroll','9060'), ('Operations Manager Payroll','9060'), ('Payroll','9060'),
  ('Sales Team Payroll/Commission','8620'),
  ('Employer CPP & EI Contributions – Admin & Sales','8622'), ('Employer CPP & EI Contributions - Admin & Sales','8622'),
  ('Employee Benefits – Admin & Sales','8622'), ('Employee Benefits - Admin & Sales','8622'),
  ('Retirement Contributions – Owner','8622'), ('Retirement Contributions - Owner','8622'),
  ('Vehicle Expenses','9281'), ('Vehicle Lease','9281'), ('Vehicle Repairs','9281'), ('Fuel – Overhead','9281'), ('Fuel - Overhead','9281'),
  ('Vehicle Loan Interest','8710'),
  ('CGL Insurance','8690'), ('Insurance – Other','8690'), ('Insurance - Other','8690'),
  ('Health Insurance – Owner','8690'), ('Health Insurance - Owner','8690'),
  ('Workers Compensation – Admin','8690'), ('Workers Compensation - Admin','8690'), ('Insurance','8690'),
  ('Accounting & Bookkeeping','8862'), ('Legal Fees','8861'), ('Professional Fees','8860'),
  ('Office Rent','8910'), ('Office Supplies','8811'), ('Postage & Delivery','8811'),
  ('Software Subscriptions','8811'), ('Office & Admin','8811'),
  ('Utilities','9220'),
  ('Property Taxes','9180'),
  ('Licenses','8760'), ('Registration','8760'), ('Taxes','8760'),
  ('Interest Expense','8710'), ('Bank Charges','8710'), ('Financial','8710'),
  ('Depreciation','8670'),
  ('Travel – Airfare & Lodging','9200'), ('Travel - Airfare & Lodging','9200'), ('Travel & Meals','9200'),
  ('Meals (50% deductible)','8523'),
  ('Bad Debt Expense','8590'),
  ('Continuing Education / Professional Development','9270'), ('Parking','9270'), ('Gifts','9270'), ('Recruiting','9270'),
  ('Owner''s Draw','3660'),
  ('Office Equipment','1740'), ('Equipment','1740'), ('Computer Equipment','1774')
) AS c(name, code)
WHERE master_coa.account_name = c.name AND master_coa.gifi_code IS NULL;
