-- Migration 124: retarget legacy bank-rule targets to master COA names
-- ──────────────────────────────────────────────────────────────────────
-- Why: 400+ ACTIVE per-client bank rules still point at pre-standardization
-- account names (fleet audit 2026-07-13: 102× "Job Supplies", 73× "Fuel –
-- Admin & Sales Vehicles", 59× "Paint & Materials", 41× the old ad name, …).
-- Daily-recon applies these nightly (tier 2, after the vendor KB), so they
-- keep re-feeding legacy accounts — this is how "Paint & Materials" kept
-- accruing on Dominion's P&L after cleanup. Retargeting the rules stops the
-- leak at the source; vendor remediation moves the already-posted rows.
--
-- Idempotent. Normalizes en-dash/hyphen when matching. Only touches ACTIVE
-- rules; the rule's vendor_pattern & client scoping are unchanged.

create or replace function _norm_acct(t text) returns text language sql immutable as
$$ select lower(regexp_replace(translate(coalesce(t,''), '–—−', '---'), '\s+', ' ', 'g')) $$;

-- 1) Unambiguous retargets (old name → current master name)
update bank_rules set target_account_name = 'Job Supplies & Materials'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Job Supplies'), _norm_acct('Paint & Materials'), _norm_acct('Coating Supplies/Materials'));

update bank_rules set target_account_name = 'Fuel – Overhead'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Fuel – Admin & Sales Vehicles'), _norm_acct('GAS'), _norm_acct('Gasoline'), _norm_acct('Fuel'));

update bank_rules set target_account_name = 'Online Advertising - Ad Spend'
 where status = 'active' and _norm_acct(target_account_name) =
   _norm_acct('Online Advertising – Google Ads / Social Media Marketing');

update bank_rules set target_account_name = 'Owner''s Draw'
 where status = 'active' and _norm_acct(target_account_name) in
   (_norm_acct('Owner Draw / Salary'), _norm_acct('Owner Draw'), _norm_acct('Owner Draws'));

update bank_rules set target_account_name = 'Subcontractors'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Subcontractors – Painting');

update bank_rules set target_account_name = 'Vehicle Repairs'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('Vehicle Repairs – Admin/Sales');

update bank_rules set target_account_name = 'CGL Insurance'
 where status = 'active' and _norm_acct(target_account_name) = _norm_acct('General Liability Insurance');

-- 2) Rules pointing at Uncategorized are worse than no rule — deactivate.
update bank_rules set status = 'inactive'
 where status = 'active' and _norm_acct(target_account_name) like '%uncategor%';

drop function _norm_acct(text);

-- 3) Verify: remaining active rules with non-master targets (expect a short
--    tail of judgment calls — Distributions, Taxes paid, Dues & Subscriptions,
--    Personal expense, Vehicle Parking & Tolls — left for Mike to decide).
select target_account_name, count(*)
  from bank_rules
 where status = 'active'
   and lower(regexp_replace(translate(coalesce(target_account_name,''), '–—−', '---'), '\s+', ' ', 'g')) not in (
     select lower(regexp_replace(translate(account_name, '–—−', '---'), '\s+', ' ', 'g'))
       from master_coa where industry = 'painters'
   )
 group by 1 order by 2 desc limit 25;
