-- Migration 13: Painters COA refresh + seed remaining industries
--
-- 1) Replace the painters master COA (US + CA) with the latest spec
-- 2) Seed the other 8 industries with the same structure so the templates
--    editor + analyze step actually show different content per industry
-- 3) Industry-specific account name overrides (Revenue + Subcontractors + the
--    primary "materials" COGS account)
--
-- Idempotent: deletes existing rows for each (industry, jurisdiction) tuple
-- before re-inserting. Re-running this migration cleanly rebuilds the COA.

BEGIN;

-- ─── Wipe existing rows for every industry we're seeding ─────────────────
DELETE FROM master_coa
WHERE industry IN (
  'painters', 'hvac', 'plumbers', 'roofers', 'electricians',
  'remodelers', 'landscapers', 'general_contractors', 'chimney_sweepers'
);

-- ─── Helper: seed one industry × one jurisdiction ───────────────────────
-- We use a small CTE template — pass the industry key, jurisdiction, and
-- the three industry-specific account names (revenue_primary, revenue_secondary,
-- subcontractors_label, materials_label) and the inserts cascade.

CREATE TEMP TABLE _coa_template (
  account_name        text,
  section             account_section,
  qbo_account_type    text,
  qbo_account_subtype text,
  expense_category    expense_category,
  parent_account_name text,
  is_parent           boolean,
  is_required         boolean,
  sort_order          integer,
  notes               text
);

-- Universal template — Revenue + COGS + Operating Expenses.
-- The {{REVENUE_1}}, {{REVENUE_2}}, {{SUBCONTRACTORS}}, {{MATERIALS}} tokens
-- get substituted per-industry below.
INSERT INTO _coa_template VALUES
  -- REVENUE (top-level, no parent)
  ('{{REVENUE_1}}',                              'revenue',          'Income',             'ServiceFeeIncome',     NULL,                 NULL, false, true,   10, 'Primary service revenue'),
  ('{{REVENUE_2}}',                              'revenue',          'Income',             'ServiceFeeIncome',     NULL,                 NULL, false, false,  20, 'Secondary revenue line'),

  -- COGS (Direct Job Costs Only)
  ('Direct Field Labor',                         'cogs',             'Cost of Goods Sold', 'CostOfLaborCos',       'cogs',               NULL, false, true,  100, 'Wages paid to field crew directly tied to jobs'),
  ('Employer Payroll Taxes – Field',             'cogs',             'Cost of Goods Sold', 'CostOfLaborCos',       'cogs',               NULL, false, true,  110, 'FICA/Medicare/SUTA/FUTA on field payroll'),
  ('Workers Compensation – Field',               'cogs',             'Cost of Goods Sold', 'CostOfLaborCos',       'cogs',               NULL, false, true,  120, 'WC premiums for field crew'),
  ('{{MATERIALS}}',                              'cogs',             'Cost of Goods Sold', 'SuppliesMaterialsCogs','cogs',               NULL, false, true,  130, 'Primary materials COGS'),
  ('Job Supplies',                               'cogs',             'Cost of Goods Sold', 'SuppliesMaterialsCogs','cogs',               NULL, false, true,  140, 'Consumables specific to a job'),
  ('Equipment Rental (Job-Specific)',            'cogs',             'Cost of Goods Sold', 'EquipmentRentalCos',   'cogs',               NULL, false, false, 150, 'Rented equipment used directly on a job'),
  ('{{SUBCONTRACTORS}}',                         'cogs',             'Cost of Goods Sold', 'OtherCostsOfServiceCOGS','cogs',             NULL, false, true,  160, 'Outsourced labor on jobs'),
  ('Job Disposal Fees',                          'cogs',             'Cost of Goods Sold', 'OtherCostsOfServiceCOGS','cogs',             NULL, false, false, 170, 'Dump/landfill fees tied to jobs'),
  ('Permit Fees',                                'cogs',             'Cost of Goods Sold', 'OtherCostsOfServiceCOGS','cogs',             NULL, false, false, 180, 'Building/work permits tied to jobs'),
  ('Direct Fuel Allocation',                     'cogs',             'Cost of Goods Sold', 'OtherCostsOfServiceCOGS','cogs',             NULL, false, false, 190, 'Fuel for crew vehicles tied to job travel'),
  ('Small Tools',                                'cogs',             'Cost of Goods Sold', 'SuppliesMaterialsCogs','cogs',               NULL, false, false, 200, 'Tool purchases under capitalization threshold'),

  -- MARKETING
  ('Online Advertising – Google Ads / Social Media Marketing',
                                                  'operating_expense','Expense',            'AdvertisingPromotional','marketing',         NULL, false, true,  300, 'Paid digital ads'),
  ('Trade Shows / Industry Events',              'operating_expense','Expense',            'AdvertisingPromotional','marketing',         NULL, false, false, 310, 'Booth, sponsorship, registration fees'),
  ('Marketing Tools',                            'operating_expense','Expense',            'AdvertisingPromotional','marketing',         NULL, false, false, 320, 'CRM, email tools, design tools used for marketing'),
  ('Networking Events',                          'operating_expense','Expense',            'AdvertisingPromotional','marketing',         NULL, false, false, 330, 'Industry networking dues, event tickets'),

  -- SALARIES & PAYROLL
  ('Owner Draw / Salary',                        'operating_expense','Expense',            'PayrollExpenses',      'salaries_payroll',   NULL, false, true,  400, 'Owner compensation'),
  ('Operations Manager Salary',                  'operating_expense','Expense',            'PayrollExpenses',      'salaries_payroll',   NULL, false, false, 410, 'Ops Manager W-2 salary'),
  ('Admin Team Salaries',                        'operating_expense','Expense',            'PayrollExpenses',      'salaries_payroll',   NULL, false, true,  420, 'Office staff wages'),
  ('Sales Team Salaries/Commission',             'operating_expense','Expense',            'PayrollExpenses',      'salaries_payroll',   NULL, false, false, 430, 'Sales base salary + commission'),
  ('Employer Payroll Taxes – Admin & Sales',     'operating_expense','Expense',            'PayrollExpenses',      'salaries_payroll',   NULL, false, true,  440, 'FICA/Medicare/SUTA/FUTA on non-field payroll'),
  ('Employee Benefits – Admin & Sales',          'operating_expense','Expense',            'PayrollExpenses',      'salaries_payroll',   NULL, false, false, 450, 'Health, retirement, perks for admin & sales'),

  -- GENERAL OPERATING
  ('Accounting & Bookkeeping',                   'operating_expense','Expense',            'LegalProfessionalFees','general_operating',  NULL, false, true,  500, 'Accountant, bookkeeper, CFO services'),
  ('Bank Charges',                               'operating_expense','Expense',            'BankCharges',          'general_operating',  NULL, false, true,  510, 'Monthly fees, NSF, wire fees'),
  ('Legal Fees',                                 'operating_expense','Expense',            'LegalProfessionalFees','general_operating',  NULL, false, false, 520, 'Attorney/lawyer fees'),
  ('Credit Card Processing Fee',                 'operating_expense','Expense',            'BankCharges',          'general_operating',  NULL, false, false, 530, 'CC merchant processing fees'),
  ('Stripe Processing Fee',                      'operating_expense','Expense',            'BankCharges',          'general_operating',  NULL, false, false, 540, 'Stripe-specific processing fees'),
  ('Payroll Processing Fee',                     'operating_expense','Expense',            'BankCharges',          'general_operating',  NULL, false, false, 550, 'Gusto/ADP/QBO Payroll service fees'),
  ('Office Rent',                                'operating_expense','Expense',            'RentOrLeaseOfBuildings','general_operating', NULL, false, true,  560, 'Office space rent'),
  ('Office Supplies',                            'operating_expense','Expense',            'OfficeExpenses',       'general_operating',  NULL, false, true,  570, 'Paper, pens, printer ink, etc.'),
  ('Utilities',                                  'operating_expense','Expense',            'Utilities',            'general_operating',  NULL, false, true,  580, 'Electric, water, gas, internet'),
  ('General Liability Insurance',                'operating_expense','Expense',            'Insurance',            'general_operating',  NULL, false, true,  590, 'GL insurance premiums'),
  ('Workers Compensation – Admin',               'operating_expense','Expense',            'Insurance',            'general_operating',  NULL, false, false, 600, 'WC premiums for admin staff'),
  ('Vehicle Lease – Admin/Sales',                'operating_expense','Expense',            'Auto',                 'general_operating',  NULL, false, false, 610, 'Lease payments for admin/sales vehicles'),
  ('Vehicle Repairs – Admin/Sales',              'operating_expense','Expense',            'VehicleRepairs',       'general_operating',  NULL, false, false, 620, 'Admin/sales vehicle maintenance'),
  ('Vehicle Parking & Tolls - Admin/Sales',      'operating_expense','Expense',            'Auto',                 'general_operating',  NULL, false, false, 630, 'Parking and toll charges'),
  ('Fuel – Admin & Sales Vehicles',              'operating_expense','Expense',            'VehicleFuel',          'general_operating',  NULL, false, false, 640, 'Non-job fuel for admin/sales vehicles'),
  ('Health Insurance – Owner',                   'operating_expense','Expense',            'Insurance',            'general_operating',  NULL, false, false, 650, 'Owner health insurance premiums'),
  ('Insurance – Other',                          'operating_expense','Expense',            'Insurance',            'general_operating',  NULL, false, false, 660, 'Other business insurance not categorized above'),
  ('Interest Expense',                           'other_expense',    'Other Expense',      'OtherMiscellaneousExpense','general_operating',NULL, false, false, 670, 'Interest on business loans / lines of credit'),
  ('Depreciation – Equipment & Vehicles',        'other_expense',    'Other Expense',      'Depreciation',         'general_operating',  NULL, false, false, 680, 'Non-cash depreciation expense'),
  ('Meals (50% deductible)',                     'operating_expense','Expense',            'TravelMeals',          'general_operating',  NULL, false, true,  690, '50% deductible business meals'),
  ('Travel – Airfare & Lodging',                 'operating_expense','Expense',            'Travel',               'general_operating',  NULL, false, false, 700, 'Business travel expenses'),
  ('Postage & Delivery',                         'operating_expense','Expense',            'OfficeExpenses',       'general_operating',  NULL, false, false, 710, 'USPS, UPS, FedEx, courier'),
  ('Continuing Education / Professional Development',
                                                  'operating_expense','Expense',            'OtherMiscellaneousServiceCost','general_operating',NULL,false,false,720, 'Industry courses, certifications, books'),
  ('Software Subscriptions',                     'operating_expense','Expense',            'OtherMiscellaneousServiceCost','general_operating',NULL, false, true,  730, 'SaaS subscriptions for the business'),
  ('Retirement Contributions – Owner',           'operating_expense','Expense',            'PayrollExpenses',      'general_operating',  NULL, false, false, 740, 'SEP-IRA / Solo-401k contributions for owner');

-- ─── Now generate (industry, jurisdiction) row sets via substitution ─────

DO $$
DECLARE
  rec    record;
  jur    text;
  ind    text;
  rev1   text;
  rev2   text;
  sub    text;
  mat    text;
BEGIN
  FOR jur IN SELECT unnest(ARRAY['US','CA']::text[])
  LOOP
    FOR ind, rev1, rev2, sub, mat IN
      VALUES
        ('painters',            'Painting Revenue',          'Remodeling Commercial',         'Subcontractors – Painting',    'Paint & Materials'),
        ('hvac',                'HVAC Service Revenue',      'HVAC Installation Revenue',     'Subcontractors – HVAC',        'Equipment & Refrigerants'),
        ('plumbers',            'Plumbing Service Revenue',  'Plumbing Installation Revenue', 'Subcontractors – Plumbing',    'Pipe, Fittings & Materials'),
        ('roofers',             'Roofing Revenue',           'Repair Revenue',                'Subcontractors – Roofing',     'Shingles & Materials'),
        ('electricians',        'Electrical Service Revenue','Electrical Installation Revenue','Subcontractors – Electrical', 'Wire, Fixtures & Materials'),
        ('remodelers',          'Remodeling Revenue',        'Repair Revenue',                'Subcontractors – Remodeling',  'Building Materials'),
        ('landscapers',         'Landscaping Revenue',       'Maintenance Revenue',           'Subcontractors – Landscaping', 'Plants & Materials'),
        ('general_contractors', 'Contract Revenue',          'Service Revenue',               'Subcontractors',               'Building Materials'),
        ('chimney_sweepers',    'Sweeping Revenue',          'Repair Revenue',                'Subcontractors',               'Materials & Supplies')
    LOOP
      INSERT INTO master_coa (
        jurisdiction, industry,
        account_name, section, qbo_account_type, qbo_account_subtype,
        expense_category, parent_account_name, is_parent, is_required, sort_order, notes
      )
      SELECT
        jur::jurisdiction_code, ind,
        replace(replace(replace(replace(
          t.account_name,
          '{{REVENUE_1}}',     rev1),
          '{{REVENUE_2}}',     rev2),
          '{{SUBCONTRACTORS}}',sub),
          '{{MATERIALS}}',     mat),
        t.section, t.qbo_account_type, t.qbo_account_subtype,
        t.expense_category, t.parent_account_name, t.is_parent, t.is_required, t.sort_order, t.notes
      FROM _coa_template t;
    END LOOP;
  END LOOP;
END$$;

DROP TABLE _coa_template;

COMMIT;

-- ─── Verify ──────────────────────────────────────────────────────────────
SELECT industry, jurisdiction, COUNT(*) AS account_count
FROM master_coa
WHERE industry IN (
  'painters','hvac','plumbers','roofers','electricians',
  'remodelers','landscapers','general_contractors','chimney_sweepers'
)
GROUP BY industry, jurisdiction
ORDER BY industry, jurisdiction;
