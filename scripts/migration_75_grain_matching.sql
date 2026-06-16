-- Migration 75 — Grain call recordings: cache + matching + learned rules
-- =========================================================================
-- Persists Ironbooks-hosted Grain recordings, their match to SNAP clients,
-- and the rules learned from manual matches so future calls auto-match.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- ── Cached recordings (one row per Grain recording) ──
create table if not exists grain_recordings (
  id text primary key,                       -- Grain recording/meeting id
  title text,
  url text,
  start_datetime timestamptz,
  duration text,
  summary text,
  host_email text,                           -- the @ironbooks.com host
  host_name text,
  participants jsonb,                        -- [{name,email,scope}]
  action_items jsonb,                        -- [{text,status,due_date,assignee_name,transcript_url}]
  has_ironbooks_host boolean not null default false,
  -- Admin marked "not a client" (prospect / team / recruiting) → hidden from
  -- the matching queue. Distinct from "matched" (which lives in the join table).
  ignored boolean not null default false,
  raw jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grain_recordings_ironbooks_idx on grain_recordings(has_ironbooks_host);
create index if not exists grain_recordings_ignored_idx on grain_recordings(ignored);
create index if not exists grain_recordings_start_idx on grain_recordings(start_datetime desc);

-- ── Recording → client matches (a group call can match several clients) ──
create table if not exists grain_recording_matches (
  id uuid primary key default gen_random_uuid(),
  recording_id text not null references grain_recordings(id) on delete cascade,
  client_link_id uuid not null references client_links(id) on delete cascade,
  -- How the match was made: auto via email / name / a learned rule, or a
  -- bookkeeper picked it by hand in the Call Matching tab.
  match_method text not null check (match_method in ('auto_email','auto_name','auto_rule','manual')),
  matched_by uuid references users(id),
  matched_at timestamptz not null default now(),
  unique (recording_id, client_link_id)
);

create index if not exists grain_matches_client_idx on grain_recording_matches(client_link_id);
create index if not exists grain_matches_recording_idx on grain_recording_matches(recording_id);

-- ── Learned match rules (every manual match writes one so it sticks) ──
-- When a future recording has a participant whose email (or normalized name)
-- equals match_value, it auto-matches to client_link_id.
create table if not exists grain_match_rules (
  id uuid primary key default gen_random_uuid(),
  rule_type text not null check (rule_type in ('email','name','domain')),
  match_value text not null,                 -- lowercased email / normalized name / email domain
  client_link_id uuid not null references client_links(id) on delete cascade,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (rule_type, match_value, client_link_id)
);

create index if not exists grain_match_rules_value_idx on grain_match_rules(match_value);
