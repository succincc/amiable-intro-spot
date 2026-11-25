-- ============================================================================
-- Career portals + distance filtering
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- companies: reach Workday tenants, not just board tokens
-- ---------------------------------------------------------------------------
alter table companies add column if not exists pod         text;  -- workday: "wd5"
alter table companies add column if not exists site        text;  -- workday site id
alter table companies add column if not exists careers_url text;  -- what was pasted
alter table companies add column if not exists last_error  text;

alter table companies drop constraint if exists companies_ats_check;
alter table companies add constraint companies_ats_check
  check (ats in ('greenhouse','lever','ashby','workable','smartrecruiters','workday'));

-- A Workday tenant can host several sites, so uniqueness is tenant+site, not
-- the token alone.
alter table companies drop constraint if exists companies_ats_token_key;
drop index if exists companies_unique_target;
create unique index companies_unique_target
  on companies (ats, token, coalesce(site, ''));

-- ---------------------------------------------------------------------------
-- distance
-- ---------------------------------------------------------------------------
alter table profile add column if not exists home_city text;
alter table profile add column if not exists home_lat  double precision;
alter table profile add column if not exists home_lon  double precision;

alter table search_config add column if not exists radius_miles             int     default 40;
alter table search_config add column if not exists include_remote           boolean default true;
alter table search_config add column if not exists include_unknown_location boolean default true;

alter table jobs add column if not exists lat            double precision;
alter table jobs add column if not exists lon            double precision;
alter table jobs add column if not exists distance_miles int;

create index if not exists idx_jobs_distance on jobs(distance_miles);

-- Geocoding results, cached forever. Job locations repeat heavily — thousands
-- of postings resolve to a few hundred towns — so this turns a rate-limited
-- lookup into a handful of calls per run. Misses are cached too: an
-- unparseable location string stays unparseable, and re-querying it every run
-- would spend the rate limit on nothing.
create table if not exists geo_cache (
  place      text primary key,
  lat        double precision,
  lon        double precision,
  found      boolean default false,
  created_at timestamptz default now()
);

alter table geo_cache enable row level security;
drop policy if exists owner_all on geo_cache;
create policy owner_all on geo_cache for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- answers: keep employer-specific answers out of the reuse pool
-- ---------------------------------------------------------------------------
-- Without this, the answer written for "Why do you want to work at Target?"
-- gets reused on a JPMorgan application. One wrong paragraph like that is
-- worse than a hundred blank fields, because a human sees it immediately.
alter table answers add column if not exists reusable  boolean default true;
alter table answers add column if not exists generated boolean default false;

-- ---------------------------------------------------------------------------
-- stats gain a distance breakdown
-- ---------------------------------------------------------------------------
create or replace view v_stats as
select
  count(*)                                                as total,
  count(*) filter (where status = 'new')                  as new,
  count(*) filter (where status = 'review')               as review,
  count(*) filter (where status = 'queued')               as queued,
  count(*) filter (where status = 'applied')              as applied,
  count(*) filter (where status = 'needs_help')           as needs_help,
  count(*) filter (where status = 'interview')            as interviews,
  count(*) filter (where status = 'offer')                as offers,
  count(*) filter (where status = 'rejected')             as rejected,
  count(*) filter (where applied_at::date = current_date) as applied_today,
  count(*) filter (where confirm_state = 'confirmed')     as confirmed,
  count(*) filter (where remote)                          as remote_jobs,
  count(*) filter (where distance_miles is not null
                     and distance_miles <= 25)            as within_25mi,
  count(*) filter (where distance_miles is not null
                     and distance_miles <= 40)            as within_40mi
from jobs;
