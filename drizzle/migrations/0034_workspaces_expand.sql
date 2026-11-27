-- One workspace per person: the first of two steps.
--
-- Until now there has been one of everything: one profile, one list of jobs,
-- one mailbox. This step gives every row an owner without changing anything
-- that happens. It only adds:
--
--   1. a copy of every table as it stands, in a schema of its own that the
--      panel cannot reach (backup_single_user), to go back to if needed;
--   2. a user_id on every table that will be a person's own, filled in with
--      the owner's for everything that exists, and filled in by itself for
--      everything written from now on;
--   3. beside each "only one of these" rule (one row per posting address,
--      one per employer board…), the same rule per person, so that two
--      people can later hold the same posting;
--   4. a function that reports how the database is put together, for the
--      owner only, so the second step can be written against what is really
--      there and not against a guess.
--
-- Who can read what is NOT changed here: every table stays the owner's
-- alone. The second step opens each person's own rows to them, and is not
-- applied until this one has been seen to work.
--
-- Safe to run twice: everything is "if not there already".

do $$
begin
  if to_regclass('public.app_owner') is null or to_regprocedure('public.is_app_owner()') is null then
    raise exception 'app_owner / is_app_owner() are missing; this database is not the one this step was written for.';
  end if;
  if (select count(*) from public.app_owner) <> 1 then
    raise exception 'expected exactly one owner in app_owner, found %', (select count(*) from public.app_owner);
  end if;
end $$;

-- 1. The copy. Made once; a second run leaves the first copy alone.
create schema if not exists backup_single_user;
revoke all on schema backup_single_user from public, anon, authenticated;
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    if to_regclass(format('backup_single_user.%I', t.tablename)) is null then
      execute format('create table backup_single_user.%I as table public.%I', t.tablename, t.tablename);
    end if;
  end loop;
end $$;

-- 2. Whose row is this.
--
-- app_uid() is the person a request is for. Normally that is whoever is
-- signed in. The owner's own login — which is also the one the runners on
-- GitHub sign in with — may name another person in a request header, and
-- then the request is carried out as that person: that is how one runner
-- does each person's round in turn. Nobody else's header is listened to.
create or replace function public.app_uid()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  named text;
begin
  if me is null then
    return null;
  end if;
  begin
    named := nullif(current_setting('request.headers', true), '')::json ->> 'x-act-as';
  exception when others then
    named := null;
  end;
  if named is not null
     and named ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and exists (select 1 from app_owner where user_id = me) then
    return named::uuid;
  end if;
  return me;
end $$;

-- What a new row is stamped with: the person the request is for, or — for
-- the panel's own server, which signs in as nobody — the owner, exactly as
-- everything has belonged to the owner until now. The second step takes
-- that fallback away once the server names the person itself.
create or replace function public.app_uid_or_owner()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.app_uid(), (select user_id from app_owner limit 1))
$$;

do $$
declare
  t text;
  owner uuid := (select user_id from public.app_owner limit 1);
  ix record;
  twin text;
  def text;
begin
  foreach t in array array[
    'agent', 'answers', 'call_keys', 'companies', 'company_candidates', 'email_sync', 'emails',
    'experience', 'google_tokens', 'jobs', 'outreach', 'profile', 'runs', 'search_config', 'site_accounts'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table public.%I add column if not exists user_id uuid', t);
    execute format('update public.%I set user_id = $1 where user_id is null', t) using owner;
    execute format('alter table public.%I alter column user_id set default public.app_uid_or_owner()', t);
    execute format('create index if not exists %I on public.%I (user_id)', 'idx_' || t || '_user', t);

    -- 3. Each "only one" rule again, per person. The rule's own definition is
    -- copied with user_id put first, so whatever it says about empty values
    -- or which rows it covers is kept as it is.
    for ix in
      select c.relname as name, pg_get_indexdef(i.indexrelid) as def
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = format('public.%I', t)::regclass
        and i.indisunique and not i.indisprimary
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'user_id')
    loop
      twin := left(ix.name, 55) || '_per_user';
      if to_regclass(format('public.%I', twin)) is null then
        def := regexp_replace(ix.def, 'INDEX \S+ ON', format('INDEX %I ON', twin));
        def := regexp_replace(def, 'USING (\w+) \(', 'USING \1 (user_id, ');
        execute def;
      end if;
    end loop;
  end loop;

  -- The tables that hold one row: one row per person, from now on.
  foreach t in array array['agent', 'call_keys', 'email_sync', 'google_tokens', 'profile', 'search_config'] loop
    if to_regclass(format('public.%I', t)) is not null
       and to_regclass(format('public.%I', t || '_one_per_user')) is null then
      execute format('create unique index %I on public.%I (user_id)', t || '_one_per_user', t);
    end if;
  end loop;
end $$;

-- 4. How the database is put together, for the owner only. Names and
-- definitions; never a row of anybody's data.
create or replace function public.schema_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_app_owner() then
    raise exception 'owner only';
  end if;
  return jsonb_build_object(
    'tables', (select jsonb_object_agg(c.relname, jsonb_build_object(
        'rls', c.relrowsecurity,
        'rows', (select n_live_tup from pg_stat_user_tables s where s.relid = c.oid),
        'no_user', case when exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) then 0 else -1 end,
        'columns', (select jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end order by a.attnum)
                    from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)))
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
    'indexes', (select jsonb_agg(pg_get_indexdef(i.indexrelid) || case when i.indisprimary then ' -- primary' else '' end)
      from pg_index i join pg_class c on c.oid = i.indrelid
      where c.relnamespace = 'public'::regnamespace and (i.indisunique or i.indisprimary)),
    'constraints', (select jsonb_agg(conrelid::regclass::text || ': ' || conname || ' ' || pg_get_constraintdef(oid))
      from pg_constraint where connamespace = 'public'::regnamespace and contype in ('c', 'f')),
    'policies', (select jsonb_agg(tablename || ': ' || policyname || ' ' || cmd || ' to ' || array_to_string(roles, ',') || ' using ' || coalesce(qual, '-') || ' check ' || coalesce(with_check, '-'))
      from pg_policies where schemaname in ('public', 'storage')),
    'views', (select jsonb_object_agg(c.relname, jsonb_build_object('options', c.reloptions, 'def', left(pg_get_viewdef(c.oid), 1500)))
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'),
    'functions', (select jsonb_object_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
        jsonb_build_object('definer', p.prosecdef, 'def', left(pg_get_functiondef(p.oid), 2500)))
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'),
    'triggers', (select jsonb_agg(event_object_table || ': ' || trigger_name || ' ' || action_timing || ' ' || event_manipulation || ' -> ' || action_statement)
      from information_schema.triggers where trigger_schema = 'public'),
    'buckets', (select jsonb_agg(jsonb_build_object('id', id, 'public', public)) from storage.buckets),
    'realtime', (select jsonb_agg(tablename) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public')
  );
end $$;
revoke all on function public.schema_report() from public;
grant execute on function public.schema_report() to authenticated;