-- ============================================================================
-- Make the companies uniqueness rule match how the code actually upserts.
--
-- Two bugs, one root cause.
--
-- BUG 1 — adding any company failed outright.
--   The earlier migration created:
--     create unique index ... on companies (ats, token, coalesce(site, ''));
--   addCompanyByUrl upserts with  on conflict (ats, token, site).
--   Postgres infers the arbiter index from the exact column list, and an
--   index over the EXPRESSION coalesce(site,'') is not an index over the
--   COLUMN site. So every insert raised 42P10, "there is no unique or
--   exclusion constraint matching the ON CONFLICT specification". Reproduced
--   on PostgreSQL 16: the careers-portal feature could never add a single
--   company.
--
-- BUG 2 — the obvious fix allows silent duplicates.
--   Replacing it with a plain  unique (ats, token, site)  makes the upsert
--   work, but in a unique index NULLs are distinct from each other by
--   default. Greenhouse, Lever, Ashby, Workable and SmartRecruiters all have
--   no site id, so site is NULL for every one of them, so every re-add
--   inserts another row. Verified: adding Stripe twice produced two Stripe
--   rows, which means discovery then pulls that board twice.
--
-- The fix is one index on the real columns with NULLS NOT DISTINCT, so NULL
-- site values compare equal and a board can only appear once, while two
-- different sites on the same Workday tenant stay separate rows.
-- ============================================================================

do $$
declare
  idx  record;
  dups int;
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception
      'This migration needs PostgreSQL 15 or newer for NULLS NOT DISTINCT (found %).',
      current_setting('server_version');
  end if;

  -- A unique rule can exist as a CONSTRAINT rather than a bare index, and the
  -- index behind a constraint cannot be dropped directly — "cannot drop index
  -- ... because constraint ... requires it". So constraints go first, by
  -- lookup rather than by name for the same reason as below.
  for idx in
    select c.conname as indexname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'companies'
      and c.contype in ('u', 'p')
      and pg_get_constraintdef(c.oid) ilike '%site%'
  loop
    execute format('alter table public.companies drop constraint if exists %I', idx.indexname);
  end loop;

  -- Then clear out every remaining unique index on companies that involves
  -- `site`, whatever it is called. The broken expression index and any
  -- hand-made replacement both have to go, and a replacement added outside
  -- version control will not have a name this migration can predict.
  for idx in
    select i.indexname
    from pg_indexes i
    where i.schemaname = 'public'
      and i.tablename  = 'companies'
      and i.indexdef ilike '%unique%'
      and i.indexdef ilike '%site%'
  loop
    execute format('drop index if exists public.%I', idx.indexname);
  end loop;

  -- Any duplicates already created while a plain index was in force must go
  -- before a stricter index can be built, or this migration fails on exactly
  -- the databases that most need it. Keep the oldest row of each group: it is
  -- the one discovery has been using, so it carries the real last_pulled and
  -- job_count.
  with ranked as (
    select id,
           row_number() over (
             partition by ats, token, coalesce(site, '')
             order by created_at nulls last, id
           ) as rn
    from companies
  )
  delete from companies c
   using ranked r
   where c.id = r.id and r.rn > 1;

  get diagnostics dups = row_count;
  if dups > 0 then
    raise notice 'Removed % duplicate company row(s).', dups;
  end if;

  execute 'create unique index companies_unique_target
             on public.companies (ats, token, site) nulls not distinct';
end $$;
