-- ============================================================================
-- Autopilot, same-state filtering, and a daily cap that is actually enforced
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- autopilot
-- ---------------------------------------------------------------------------
-- Unattended applying used to be decided by a YAML expression: a scheduled
-- run carried no inputs, so dry_run fell through to false and it submitted.
-- Four real applications went out that way before anyone asked for them.
--
-- It is now a stored setting, off by default, that the applier reads at the
-- start of every scheduled run. Somebody has to switch it on, in the panel,
-- where they can see that it is on.
alter table profile add column if not exists autopilot boolean default false;

-- ---------------------------------------------------------------------------
-- same-state filtering
-- ---------------------------------------------------------------------------
-- A radius is a circle, and circles cross state lines. 50 miles from a town
-- near a border reaches two more states, which is right for some searches and
-- wrong for anyone who wants to stay licensed, taxed and commuting inside one
-- state. This narrows the circle to the home state without changing it.
alter table search_config add column if not exists same_state_only boolean default false;

-- Derived from profile.city/state the first time discovery runs, like
-- home_lat and home_lon.
alter table profile add column if not exists home_state text;

update profile
   set home_state = upper(trim(state))
 where home_state is null
   and state is not null
   and length(trim(state)) = 2;

-- ---------------------------------------------------------------------------
-- the daily cap was never enforced
-- ---------------------------------------------------------------------------
-- search_config.daily_cap existed and nothing read it. The applier only ever
-- honoured MAX_JOBS, which is per RUN — so eight scheduled runs a day at 25
-- each is 200 applications regardless of what the cap says. With autopilot
-- about to make those runs unattended, a cap nobody enforces is worse than no
-- cap at all, because it reads like a safety net.
--
-- 999999 is not a considered choice, it is a placeholder. Anything that high
-- becomes a real number.
update search_config
   set daily_cap = 50
 where daily_cap is null or daily_cap > 1000 or daily_cap < 1;

alter table search_config drop constraint if exists search_config_daily_cap_range;
alter table search_config add constraint search_config_daily_cap_range
  check (daily_cap between 1 and 1000);

alter table search_config alter column daily_cap set default 50;

-- ---------------------------------------------------------------------------
-- how many have gone out today
-- ---------------------------------------------------------------------------
-- The applier needs this before every job, and counting rows client-side
-- would mean pulling the day's applications across the wire each time.
create or replace function applications_today() returns int
language sql stable set search_path = public as $$
  select count(*)::int
    from jobs
   where applied_at >= date_trunc('day', now());
$$;

grant execute on function applications_today() to authenticated, anon, service_role;
