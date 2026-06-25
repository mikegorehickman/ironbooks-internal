-- Migration 92 — 7-day portal activation tokens
-- =========================================================================
-- Supabase magic/OTP links expire in ≤24h, which is too short for an invite a
-- client might not open for days. This is our own long-lived activation token:
-- the email links to /auth/activate?token=…, which (within 7 days) mints a
-- fresh short-lived Supabase sign-in link server-side and logs the client in.
-- So the link the client holds works for a full week.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists portal_invite_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  user_id uuid references users(id) on delete cascade,
  client_link_id uuid references client_links(id) on delete cascade,
  email text not null,
  expires_at timestamptz not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists portal_invite_tokens_token_idx on portal_invite_tokens(token);
