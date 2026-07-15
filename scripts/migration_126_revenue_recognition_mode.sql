-- Migration 126: per-client revenue-recognition mode.
--
-- Some cash-basis clients run a field CRM (Jobber / DripJobs / Housecall) that
-- pushes INVOICES into QBO. Those invoices get recognized as income on the
-- cash-basis P&L, AND the actual bank deposit that pays them is separately
-- categorized to a revenue account — so the same job is revenue twice.
-- (Dominion Painters, confirmed: Jennifer De Wit $1,002.58 invoice in Billable
-- Expense Income + $1,132.91 deposit in Service Revenue = invoice net × 1.13 HST.)
--
-- 'deposits_only' tells SNAP to recognize revenue from ACTUAL CASH RECEIPTS only
-- and exclude invoice-recognized income from the cash-basis P&L used in monthly
-- production + the close-verification gate. 'standard' = unchanged behavior.
alter table client_links
  add column if not exists revenue_recognition_mode text not null default 'standard';

-- Enable for Dominion Painters (the client this was found on).
update client_links
  set revenue_recognition_mode = 'deposits_only'
  where id = '86c12180-6f32-4316-bf04-ecb808a98fb1';
