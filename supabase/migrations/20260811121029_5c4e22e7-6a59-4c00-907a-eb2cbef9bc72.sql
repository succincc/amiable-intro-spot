create table if not exists public.profile (
  id int primary key default 1 check (id = 1),
  full_name text, preferred_name text,
  email text, phone text,
  address text, city text, province_state text, country text, postal_code text,
  linkedin_url text, github_url text, portfolio_url text,
  salary_expectation text, salary_range_min text, salary_range_max text,
  years_of_experience text, education_level text, target_role text,
  legally_authorized text, require_sponsorship text,
  gender text, race_ethnicity text, veteran_status text, disability_status text,
  resume_text text,
  updated_at timestamptz default now()
);
insert into public.profile (id) values (1) on conflict (id) do nothing;

create table if not exists public.interview_prep (
  id uuid primary key default gen_random_uuid(),
  job_url text unique not null,
  job_id uuid references public.jobs(id) on delete cascade,
  company text, title text,
  likely_questions text, talking_points text,
  questions_to_ask text, company_notes text,
  created_at timestamptz default now()
);

create table if not exists public.followups (
  id uuid primary key default gen_random_uuid(),
  job_url text unique not null,
  job_id uuid references public.jobs(id) on delete cascade,
  company text, title text,
  to_address text, subject text, body text,
  status text default 'draft',
  days_since int,
  created_at timestamptz default now()
);

alter table public.search_presets add column if not exists auto_run_hours numeric default 0;

grant select, insert, update, delete on public.profile to authenticated;
grant all on public.profile to service_role;
grant select, insert, update, delete on public.interview_prep to authenticated;
grant all on public.interview_prep to service_role;
grant select, insert, update, delete on public.followups to authenticated;
grant all on public.followups to service_role;

alter table public.profile enable row level security;
alter table public.interview_prep enable row level security;
alter table public.followups enable row level security;

drop policy if exists owner_all on public.profile;
create policy owner_all on public.profile for all to authenticated using (true) with check (true);
drop policy if exists owner_all on public.interview_prep;
create policy owner_all on public.interview_prep for all to authenticated using (true) with check (true);
drop policy if exists owner_all on public.followups;
create policy owner_all on public.followups for all to authenticated using (true) with check (true);

create or replace function public.touch_profile() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists profile_touch on public.profile;
create trigger profile_touch before update on public.profile
  for each row execute function public.touch_profile();