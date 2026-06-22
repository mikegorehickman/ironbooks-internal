-- Migration 89 — Walkthrough-email stamp
-- =========================================================================
-- Records when the SNAP software-walkthrough email was sent to a client, so
-- it fires exactly once — on the first time QuickBooks is connected for them
-- (lib/walkthrough-email). Idempotent across the several QBO-connect paths.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table client_links
  add column if not exists walkthrough_email_sent_at timestamptz;
