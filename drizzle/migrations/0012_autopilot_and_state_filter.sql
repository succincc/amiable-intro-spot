alter table profile add column if not exists autopilot boolean default false;

alter table search_config add column if not exists same_state_only boolean default false;

alter table profile add column if not exists home_state text;

update profile
   set home_state = upper(trim(state))
 where home_state is null
   and state is not null
   and length(trim(state)) = 2;

update search_config
   set daily_cap = 50
 where daily_cap is null or daily_cap > 1000 or daily_cap < 1;

alter table search_config drop constraint if exists search_config_daily_cap_range;
alter table search_config add constraint search_config_daily_cap_range
  check (daily_cap between 1 and 1000);

alter table search_config alter column daily_cap set default 50;

create or replace function applications_today() returns int
language sql stable set search_path = public as $$
  select count(*)::int
    from jobs
   where applied_at >= date_trunc('day', now());
$$;

grant execute on function applications_today() to authenticated, anon, service_role;