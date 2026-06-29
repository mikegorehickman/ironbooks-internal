-- Migration 97 — billing_admin role
-- A restricted internal role: can see + change billing (/admin/billing) only,
-- never client bookkeeping. Gated by middleware (confined to /admin/billing),
-- requireStaff (rejects it), and the billing endpoints (explicitly allow it).
--
-- ⚠️ RUN THE TWO STATEMENTS SEPARATELY in the Supabase SQL editor — a new enum
-- value can't be used in the same transaction it's added in.

-- STEP 1 — run this alone first:
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'billing_admin';

-- STEP 2 — then run this (auth user already created for jesus@paintergrowth.com):
-- INSERT INTO users (id, email, full_name, role, is_active)
-- VALUES ('f148466a-bc31-46db-b6f1-09a50028cac2', 'jesus@paintergrowth.com', 'Jesus', 'billing_admin', true)
-- ON CONFLICT (id) DO UPDATE SET role = 'billing_admin', is_active = true, full_name = EXCLUDED.full_name;
