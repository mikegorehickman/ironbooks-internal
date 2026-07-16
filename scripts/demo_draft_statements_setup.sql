-- DEMO SETUP: draft statements walkthrough on Test Painting Co LLC
--
-- For Mike's Loom demo of the DRAFT → VERIFIED flow (PR #86). Stages a
-- realistic June-2026 statement package for the DEMO client, marked as
-- delivered-as-draft, so the portal shows the amber DRAFT banner + the
-- gut-check panel immediately. Demo-client only — touches nothing else.
--
-- ORDER:
--   1. Run migration_130_draft_statements.sql FIRST (adds the columns/table).
--      Safe to apply pre-merge: current prod code ignores the new schema, and
--      nothing is client-visible until a close is SENT by the new code.
--   2. Run this file.
--   3. Demo on the PR #86 Vercel preview deployment (link on the PR):
--      portal → log in as test@ironbooks.com → Statements → June 2026 shows
--      DRAFT + gut-check → answer + approve → SNAP /today (same preview) →
--      "Draft statement reviews from clients" → Graduate to verified.
--      NOTE: use a real portal login for the approve click — admin
--      impersonation deliberately blocks attesting in a client's name.
--
-- To re-run the demo from scratch, the RESET block at the bottom puts the
-- client back to draft and clears the review.

insert into month_end_packages (
  client_link_id, period_year, period_month, period_start, period_end,
  status, portal_published_at, email_sent_at, sent_as_draft,
  ai_summary,
  pl_snapshot, bs_snapshot, ar_ap_snapshot
) values (
  '51ffff01-a1ea-420d-8bbf-32746a334ff6',  -- Test Painting Co LLC (DEMO)
  2026, 6, '2026-06-01', '2026-06-30',
  'sent', now(), now(), true,
  'June was a solid month: revenue of $48,200 against $31,450 in total costs for net income of $16,750. Job materials ran a touch high at 21% of revenue — worth watching on the Hendricks exterior job.',
  '{
    "totalIncome": 48200, "totalExpenses": 31450, "netIncome": 16750,
    "comparisonIncome": 44100, "comparisonExpenses": 30200, "comparisonNetIncome": 13900,
    "topIncomeLines": [{"label": "Service Revenue", "amount": 48200}],
    "topExpenseLines": [
      {"label": "Direct Field Labor", "amount": 14200},
      {"label": "Job Supplies & Materials", "amount": 10150},
      {"label": "Fuel – Overhead", "amount": 1890}
    ]
  }'::jsonb,
  '{
    "asOfDate": "2026-06-30",
    "totalAssets": 86400, "totalLiabilities": 23100, "totalEquity": 63300, "cashOnHand": 31250,
    "topAssets": [{"name": "Main Chequing", "balance": 31250}, {"name": "Trucks & Equipment", "balance": 42000}],
    "topLiabilities": [{"name": "PC Financial Mastercard", "balance": 4300}, {"name": "Business Loan", "balance": 18800}]
  }'::jsonb,
  '{
    "openARTotal": 12400, "openARCount": 4, "overdueARTotal": 3100, "overdueARCount": 1,
    "openAPTotal": 2150, "openAPCount": 2
  }'::jsonb
)
on conflict (client_link_id, period_year, period_month) do update set
  status = 'sent', portal_published_at = now(), email_sent_at = now(),
  sent_as_draft = true,
  ai_summary = excluded.ai_summary,
  pl_snapshot = excluded.pl_snapshot,
  bs_snapshot = excluded.bs_snapshot,
  ar_ap_snapshot = excluded.ar_ap_snapshot;

-- Make sure the demo client is in the draft stage (migration 130's default
-- already does this; explicit here so the demo is deterministic).
update client_links
  set statements_stage = 'draft', statements_verified_at = null, statements_verified_by = null
where id = '51ffff01-a1ea-420d-8bbf-32746a334ff6';

-- Verify
select period_year, period_month, status, sent_as_draft
from month_end_packages
where client_link_id = '51ffff01-a1ea-420d-8bbf-32746a334ff6';

-- ─────────────────────────────────────────────────────────────────────────
-- RESET (run between demo takes): back to draft, review cleared.
-- ─────────────────────────────────────────────────────────────────────────
-- delete from statement_reviews
--   where client_link_id = '51ffff01-a1ea-420d-8bbf-32746a334ff6';
-- update client_links
--   set statements_stage = 'draft', statements_verified_at = null, statements_verified_by = null
--   where id = '51ffff01-a1ea-420d-8bbf-32746a334ff6';
