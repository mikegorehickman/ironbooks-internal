-- Migration 84: SNAP-native Job Costing tracker (write-capable)
--
-- Models the client's "Job Cost Tracker" spreadsheet so contractors can track
-- profit by job WITHOUT QuickBooks class tracking. Per-client goal/burden
-- settings + one row per produced job (with an embedded labor breakdown).
-- Writes go through the service role (portal routes), scoped per client in
-- code; RLS on with no public policies (anon/auth keys get no access).

create table if not exists public.jc_settings (
  client_link_id uuid primary key references public.client_links(id) on delete cascade,
  goal_paint_pct numeric not null default 0.15,  -- target Paint & Supplies % of price
  goal_labor_pct numeric not null default 0.35,  -- target Labor % of price
  burden_pct     numeric not null default 0.13,  -- labor burden (taxes/WC/etc.)
  updated_at timestamptz not null default now()
);

create table if not exists public.jc_jobs (
  id uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references public.client_links(id) on delete cascade,
  job_name text not null,
  crew text,
  job_date date not null default current_date,
  job_price      numeric not null default 0,
  sales_tax      numeric not null default 0,   -- informational (not in GP)
  materials_cost numeric not null default 0,   -- "Paint & Soft Supplies"
  labor_cost     numeric not null default 0,   -- used when labor_lines is empty
  labor_lines    jsonb   not null default '[]'::jsonb, -- [{painter,wage,hours}]
  budgeted_hours numeric not null default 0,
  actual_hours   numeric not null default 0,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jc_jobs_client_idx on public.jc_jobs (client_link_id, job_date desc);

alter table public.jc_settings enable row level security;
alter table public.jc_jobs enable row level security;
-- No policies: service role bypasses RLS; anon/auth keys get no access.
