-- Migration 85 — Per-user email signature fields
-- =========================================================================
-- Each team member gets a branded email signature (name + title + phone +
-- optional booking link + avatar). Rendered into the emails they send.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table users
  add column if not exists title              text,    -- e.g. "Senior Bookkeeper"
  add column if not exists phone              text,
  add column if not exists booking_url        text,    -- optional "book a call" link
  add column if not exists signature_enabled  boolean not null default true;
