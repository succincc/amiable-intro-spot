drop table if exists public.board_credentials, public.commands, public.engine_status, public.followups, public.interview_prep, public.questions, public.search_presets, public.target_companies, public.emails, public.jobs, public.profile cascade;

create extension if not exists pg_trgm with schema extensions;

create table public.profile (
  id int primary key default 1 check (id = 1),
  full_name text, preferred_name text, email text, phone text, address text, city text, state text,
  country text default 'United States', postal_code text, linkedin_url text, github_url text, portfolio_url text,
  work_authorized text default 'Yes', needs_sponsorship text default 'No',
  veteran_status text default 'I am not a protected veteran', disability_status text default 'I do not wish to answer',
  gender text default 'Decline to self-identify', race_ethnicity text default 'Decline to self-identify',
  over_18 text default 'Yes', can_background_check text default 'Yes',
  target_role text, years_experience text, education_level text, salary_expectation int, salary_min int,
  earliest_start text default 'Immediately', willing_to_relocate text default 'No',
  resume_text text, resume_file_path text, resume_file_name text, resume_word_count int, resume_error text,
  updated_at timestamptz default now()
);
insert into public.profile (id) values (1) on conflict (id) do nothing;

create table public.search_config (
  id int primary key default 1 check (id = 1),
  titles text[] default '{}',
  locations text[] default '{Remote}',
  remote_ok boolean default true,
  salary_floor int default 0,
  exclude_titles text[] default '{intern,internship,director,vice president,vp,chief,senior director,principal}',
  exclude_companies text[] default '{}',
  no_go_patterns text[] default '{commission only,commission-only,100% commission,unlimited earning potential,door to door,door-to-door,1099 only,multi-level marketing,pyramid,be your own boss,purchase your own leads}',
  auto_apply_score int default 6,
  review_score int default 4,
  daily_cap int default 100,
  sources text[] default '{greenhouse,lever,ashby,remotive,remoteok,arbeitnow,workable,usajobs}',
  updated_at timestamptz default now()
);
insert into public.search_config (id) values (1) on conflict (id) do nothing;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ats text not null check (ats in ('greenhouse','lever','ashby','workable','smartrecruiters')),
  token text not null,
  enabled boolean default true,
  last_pulled timestamptz,
  job_count int default 0,
  created_at timestamptz default now(),
  unique (ats, token)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  apply_url text, title text not null, company text, location text,
  remote boolean default false, salary_text text, salary_min int, salary_max int,
  description text, source text, ats text,
  score int, score_reason text, scored_at timestamptz,
  tailored_resume text, tailored_at timestamptz,
  status text not null default 'new',
  skip_reason text, help_reason text,
  applied_at timestamptz, confirmed_at timestamptz, confirm_state text,
  attempts int default 0, last_error text, posted_at timestamptz,
  found_at timestamptz default now(), updated_at timestamptz default now()
);
create index idx_jobs_status on public.jobs(status);
create index idx_jobs_score on public.jobs(score desc nulls last);
create index idx_jobs_applied on public.jobs(applied_at desc);
create index idx_jobs_found on public.jobs(found_at desc);
create index idx_jobs_company on public.jobs using gin (company extensions.gin_trgm_ops);

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  q_key text unique not null,
  question text not null,
  answer text not null,
  field_type text default 'text',
  confirmed boolean default false,
  times_used int default 0,
  last_used timestamptz,
  created_at timestamptz default now()
);
create index idx_answers_key on public.answers using gin (q_key extensions.gin_trgm_ops);

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,
  from_addr text, subject text, snippet text, body text, received_at timestamptz,
  category text,
  job_id uuid references public.jobs(id) on delete set null,
  is_read boolean default false,
  created_at timestamptz default now()
);
create index idx_emails_received on public.emails(received_at desc);
create index idx_emails_category on public.emails(category);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  status text default 'running',
  found int default 0, processed int default 0, errors int default 0,
  detail jsonb default '{}', message text,
  started_at timestamptz default now(), ended_at timestamptz
);
create index idx_runs_started on public.runs(started_at desc);

create table public.agent (
  id int primary key default 1 check (id = 1),
  online boolean default false,
  last_seen timestamptz,
  state text default 'idle',
  current_job uuid references public.jobs(id) on delete set null,
  applied_today int default 0,
  version text
);
insert into public.agent (id) values (1) on conflict (id) do nothing;

grant select, insert, update, delete on public.profile, public.search_config, public.companies, public.jobs, public.answers, public.emails, public.runs, public.agent to authenticated;
grant all on public.profile, public.search_config, public.companies, public.jobs, public.answers, public.emails, public.runs, public.agent to service_role;

create view public.v_stats with (security_invoker = on) as
select
  count(*) as total,
  count(*) filter (where status = 'new') as new,
  count(*) filter (where status = 'review') as review,
  count(*) filter (where status = 'queued') as queued,
  count(*) filter (where status = 'applied') as applied,
  count(*) filter (where status = 'needs_help') as needs_help,
  count(*) filter (where status = 'interview') as interviews,
  count(*) filter (where status = 'offer') as offers,
  count(*) filter (where status = 'rejected') as rejected,
  count(*) filter (where applied_at::date = current_date) as applied_today,
  count(*) filter (where confirm_state = 'confirmed') as confirmed
from public.jobs;

create view public.v_apply_queue with (security_invoker = on) as
select j.id, j.url, j.apply_url, j.title, j.company, j.ats, j.score, j.tailored_resume, j.description
from public.jobs j
where j.status = 'queued' and j.attempts < 3
order by j.score desc nulls last, j.found_at asc;

grant select on public.v_stats, public.v_apply_queue to authenticated, service_role;

create or replace function public.route_scored_job() returns trigger
language plpgsql set search_path = public as $$
declare cfg record;
begin
  if new.score is null or new.score is not distinct from old.score then return new; end if;
  select * into cfg from public.search_config where id = 1;
  if new.score >= cfg.auto_apply_score then
    new.status := 'queued';
  elsif new.score >= cfg.review_score then
    new.status := 'review';
  else
    new.status := 'skipped';
    new.skip_reason := coalesce(new.skip_reason, 'score below review threshold');
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger trg_route_scored before update of score on public.jobs
  for each row execute function public.route_scored_job();

create or replace function public.touch_updated() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

create trigger trg_touch_jobs before update on public.jobs for each row execute function public.touch_updated();
create trigger trg_touch_profile before update on public.profile for each row execute function public.touch_updated();

create or replace function public.claim_next_job()
returns table (id uuid, url text, apply_url text, title text, company text, ats text, score int, tailored_resume text, description text)
language plpgsql set search_path = public as $$
declare cap int; done int;
begin
  select daily_cap into cap from public.search_config where search_config.id = 1;
  select count(*) into done from public.jobs where applied_at::date = current_date;
  if done >= cap then return; end if;
  return query
  with picked as (
    select j.id from public.jobs j
    where j.status = 'queued' and j.attempts < 3
    order by j.score desc nulls last, j.found_at asc
    limit 1 for update skip locked
  )
  update public.jobs j
     set status = 'applying', attempts = j.attempts + 1, updated_at = now()
    from picked
   where j.id = picked.id
  returning j.id, j.url, j.apply_url, j.title, j.company, j.ats, j.score, j.tailored_resume, j.description;
end $$;

create or replace function public.find_answer(q text)
returns table (answer text, confirmed boolean, similarity real)
language sql stable set search_path = public, extensions as $$
  select a.answer, a.confirmed, extensions.similarity(a.q_key, lower(trim(q))) as sim
  from public.answers a
  where a.q_key = lower(trim(q)) or extensions.similarity(a.q_key, lower(trim(q))) > 0.75
  order by (a.q_key = lower(trim(q))) desc, sim desc
  limit 1;
$$;

revoke execute on function public.claim_next_job() from public, anon;
revoke execute on function public.find_answer(text) from public, anon;
grant execute on function public.claim_next_job() to authenticated, service_role;
grant execute on function public.find_answer(text) to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['profile','search_config','companies','jobs','answers','emails','runs','agent']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

insert into public.companies (name, ats, token) values
  ('Stripe','greenhouse','stripe'), ('Databricks','greenhouse','databricks'), ('Instacart','greenhouse','instacart'),
  ('Robinhood','greenhouse','robinhood'), ('Doximity','greenhouse','doximity'), ('Cloudflare','greenhouse','cloudflare'),
  ('Reddit','greenhouse','reddit'), ('Gusto','greenhouse','gusto'), ('Airtable','greenhouse','airtable'),
  ('Discord','greenhouse','discord'), ('Netflix','lever','netflix'), ('Plaid','lever','plaid'),
  ('Attentive','lever','attentive'), ('Ramp','ashby','ramp'), ('Linear','ashby','linear'), ('Deel','ashby','deel')
on conflict (ats, token) do nothing;

alter publication supabase_realtime add table public.jobs, public.runs, public.agent, public.emails;