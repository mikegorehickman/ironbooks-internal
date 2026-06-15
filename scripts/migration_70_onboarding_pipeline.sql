-- Migration 70 — Onboarding pipeline (sales → onboarding → client).
-- ================================================================
-- Tracks every new sale (WON in GoHighLevel) through the onboarding form
-- and onboarding call, so admins/leads can see at a glance who hasn't
-- completed onboarding and nobody falls through the cracks.
--
-- Fed by three GHL webhooks (won / ob-form / ob-call) keyed on the stable
-- GHL contact id, with a periodic GHL-API reconciliation poll as a backstop.
-- The board lives at /onboarding (admin/lead only); a "Create client" action
-- promotes a finished lead into client_links (→ Cleanup board).
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists onboarding_leads (
  id uuid primary key default gen_random_uuid(),

  -- Stable identity from GHL — present on all three webhooks + the API.
  ghl_contact_id text unique not null,
  ghl_opportunity_id text,

  -- Contact / business details (from WON payload or GHL API enrichment).
  full_name text,
  business_name text,
  email text,
  phone text,

  -- Milestones (null until the matching event arrives; order-independent).
  won_at timestamptz,
  ob_form_submitted_at timestamptz,
  ob_form_payload jsonb,
  ob_call_scheduled_at timestamptz,      -- when the booking was created
  ob_call_time timestamptz,              -- the appointment start time
  ob_call_status text,                   -- scheduled | rescheduled | cancelled | attended | no_show
  ob_call_attended_at timestamptz,
  ob_call_grain_id text,                 -- matched Grain recording, if synced

  -- Workflow state. Stage is DERIVED in code from the milestones above;
  -- only the coarse lifecycle status is stored here.
  status text not null default 'active', -- active | converted | lost
  lost_reason text,
  assigned_to uuid references users(id),
  notes text,
  last_resend_at timestamptz,

  -- Handoff: set when "Create client" promotes this lead into client_links.
  client_link_id uuid references client_links(id),

  source text not null default 'webhook', -- webhook | reconcile | manual
  raw jsonb,                              -- last raw inbound payload (debugging)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onboarding_leads_status_idx on onboarding_leads(status);
create index if not exists onboarding_leads_assigned_idx on onboarding_leads(assigned_to);
create index if not exists onboarding_leads_won_idx on onboarding_leads(won_at);

-- Append-only log of every inbound GHL webhook — idempotency + audit trail.
create table if not exists onboarding_webhook_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                     -- won | ob_form | ob_call
  ghl_contact_id text,
  received_at timestamptz not null default now(),
  payload jsonb
);

create index if not exists onboarding_webhook_events_contact_idx
  on onboarding_webhook_events(ghl_contact_id);
create index if not exists onboarding_webhook_events_received_idx
  on onboarding_webhook_events(received_at desc);
