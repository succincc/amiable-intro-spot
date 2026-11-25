create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  title text, company text, location text,
  salary_text text, salary_min int, salary_max int,
  site text,
  full_description text,
  application_url text,
  fit_score int, score_reasoning text,
  status text not null default 'discovered',
  skip_reason text,
  attention_reason text,
  resume_pdf_path text, cover_letter_path text,
  applied_at timestamptz,
  discovered_at timestamptz,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);
grant select, insert, update, delete on public.jobs to authenticated;
grant all on public.jobs to service_role;
alter table public.jobs enable row level security;
create policy "owner manages jobs" on public.jobs for all to authenticated using (true) with check (true);

create table public.search_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean default false,
  queries jsonb not null default '[]'::jsonb,
  locations jsonb not null default '[]'::jsonb,
  job_types text[] default '{fulltime}',
  salary_floor int,
  hours_old int default 72,
  boards text[] default '{indeed,linkedin,glassdoor,zip_recruiter,google}',
  extra_sources text[] default '{}',
  exclude_titles text[] default '{}',
  exclude_companies text[] default '{}',
  no_go_patterns text[] default '{"commission only","commission-only","1099 only","unlimited earning potential","door-to-door","door to door"}',
  min_score_auto_apply int default 6,
  review_band_low int default 4,
  daily_apply_cap int default 100,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
grant select, insert, update, delete on public.search_presets to authenticated;
grant all on public.search_presets to service_role;
alter table public.search_presets enable row level security;
create policy "owner manages presets" on public.search_presets for all to authenticated using (true) with check (true);

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  command text not null,
  payload jsonb default '{}'::jsonb,
  status text default 'pending',
  error text,
  created_at timestamptz default now(),
  handled_at timestamptz
);
grant select, insert, update, delete on public.commands to authenticated;
grant all on public.commands to service_role;
alter table public.commands enable row level security;
create policy "owner manages commands" on public.commands for all to authenticated using (true) with check (true);

create table public.engine_status (
  id int primary key default 1 check (id = 1),
  online boolean default false,
  last_heartbeat timestamptz,
  current_stage text default 'idle',
  run_started_at timestamptz,
  counters jsonb default '{}'::jsonb
);
grant select, insert, update, delete on public.engine_status to authenticated;
grant all on public.engine_status to service_role;
alter table public.engine_status enable row level security;
create policy "owner manages engine status" on public.engine_status for all to authenticated using (true) with check (true);
insert into public.engine_status (id, online, current_stage, counters) values (1, false, 'idle', '{"discovered":0,"scored":0,"applied_today":0,"attention":0}'::jsonb);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  question_normalized text unique not null,
  question_raw text not null,
  answer text not null,
  answer_type text default 'text',
  confidence text default 'low',
  times_used int default 0,
  last_used_at timestamptz,
  source_job_url text,
  created_at timestamptz default now()
);
grant select, insert, update, delete on public.questions to authenticated;
grant all on public.questions to service_role;
alter table public.questions enable row level security;
create policy "owner manages questions" on public.questions for all to authenticated using (true) with check (true);

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  gmail_id text unique not null,
  from_address text, subject text, snippet text, body_text text,
  received_at timestamptz,
  category text,
  classified_by text,
  job_id uuid references public.jobs(id) on delete set null,
  is_read boolean default false,
  created_at timestamptz default now()
);
grant select, insert, update, delete on public.emails to authenticated;
grant all on public.emails to service_role;
alter table public.emails enable row level security;
create policy "owner manages emails" on public.emails for all to authenticated using (true) with check (true);

create table public.target_companies (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  ats text not null,
  board_token text not null,
  enabled boolean default true,
  created_at timestamptz default now()
);
grant select, insert, update, delete on public.target_companies to authenticated;
grant all on public.target_companies to service_role;
alter table public.target_companies enable row level security;
create policy "owner manages target companies" on public.target_companies for all to authenticated using (true) with check (true);

create index jobs_status_idx on public.jobs(status);
create index jobs_updated_idx on public.jobs(updated_at desc);
create index emails_job_idx on public.emails(job_id);

alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.engine_status;
alter publication supabase_realtime add table public.commands;
alter publication supabase_realtime add table public.emails;