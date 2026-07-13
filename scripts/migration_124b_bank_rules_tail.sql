-- Migration 124b: retarget the judgment-call tail of legacy bank-rule targets
-- (follows 124; same normalization; idempotent; active rules only)
-- Mappings decided by Mike 2026-07-13: Distributions/Personal → Owner's Draw,
-- generic COGS/Materials → Job Supplies & Materials, Computer & Internet →
-- Utilities (telecom ruling), Vehicle Parking & Tolls → Tolls, Life Insurance
-- → Insurance – Other (REVIEW: owner personal policies belong at Owner's Draw).

create or replace function _norm_acct(t text) returns text language sql immutable as
$$ select lower(regexp_replace(translate(coalesce(t,''), '–—−', '---'), '\s+', ' ', 'g')) $$;

update bank_rules set target_account_name = 'Direct Field Labor'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Direct Field Labor – Painting');
update bank_rules set target_account_name = 'Payroll Expenses'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Salaries & wages'), _norm_acct('Salaries & Payroll'));
update bank_rules set target_account_name = 'Software Subscriptions'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Software'), _norm_acct('Growth/Retention Software/SaaS'), _norm_acct('Dues & Subscriptions'));
update bank_rules set target_account_name = 'Utilities'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Computer and Internet Expenses');
update bank_rules set target_account_name = 'Owner''s Draw'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Distributions'), _norm_acct('Personal expense'));
update bank_rules set target_account_name = 'Taxes'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Taxes paid'), _norm_acct('Tax & Licenses'), _norm_acct('Taxes and Licenses'));
update bank_rules set target_account_name = 'Online Advertising - Ad Spend'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Advertising'), _norm_acct('Advertising and Promotion'), _norm_acct('Advertising & Marketing'));
update bank_rules set target_account_name = 'Fuel – Overhead'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Vehicle Fuel'), _norm_acct('Gas Expense'));
update bank_rules set target_account_name = 'Vehicle Repairs'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Auto Repairs');
update bank_rules set target_account_name = 'Tolls'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Vehicle Parking & Tolls');
update bank_rules set target_account_name = 'Job Supplies & Materials'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Materials'), _norm_acct('Cost of Goods Sold'));
update bank_rules set target_account_name = 'Subcontractors'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Subcontractor Costs');
update bank_rules set target_account_name = 'Uniforms'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Uniform');
update bank_rules set target_account_name = 'Postage & Delivery'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Shipping');
update bank_rules set target_account_name = 'Insurance – Other'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Life Insurance');

drop function _norm_acct(text);

select target_account_name, count(*)
  from bank_rules
 where status = 'active'
   and lower(regexp_replace(translate(coalesce(target_account_name,''), '–—−', '---'), '\s+', ' ', 'g')) not in (
     select lower(regexp_replace(translate(account_name, '–—−', '---'), '\s+', ' ', 'g'))
       from master_coa where industry = 'painters'
   )
 group by 1 order by 2 desc;
