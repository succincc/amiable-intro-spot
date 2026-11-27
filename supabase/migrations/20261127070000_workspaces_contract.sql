-- One workspace per person: the second step.
--
-- The first step gave every row an owner and changed nothing else. This one
-- makes that ownership the rule: a person reads and writes their own rows
-- and nobody else's. Written against the database's own description of
-- itself, taken after the first step.
--
--   1. Three views were answering with every row, to anyone, whatever the
--      tables' own rules said (v_inbox, v_stats, v_email_stats). They now
--      follow the rules of the tables under them, like the other two.
--   2. user_id becomes required, and tied to the login: removing a login
--      removes everything that was theirs.
--   3. The one-row tables hold one row per person.
--   4. The old "only one, for everybody" rules go; their per-person twins
--      from the first step stay.
--   5. Every table of a person's own is theirs alone, and only for the
--      owner or someone the owner has approved.
--   6. The few functions that looked for "the" settings look for the
--      settings of whoever the row belongs to.
--   7. A workspace is made for a person when they first come in, and the
--      owner can empty one.
--
-- Safe to run twice.

do $$
begin
  if to_regprocedure('public.app_uid()') is null or to_regclass('public.members') is null then
    raise exception 'the first workspace step and the members table must be applied before this one.';
  end if;
end $$;

-- 1. Views follow the tables' rules.
do $$
declare v record;
begin
  for v in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' loop
    execute format('alter view public.%I set (security_invoker = true)', v.relname);
  end loop;
end $$;

-- Who may have a workspace at all: the owner, and whoever the owner approved.
create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from app_owner where user_id = auth.uid())
      or exists (select 1 from members where user_id = auth.uid() and status = 'approved')
$$;

do $$
declare
  t text;
  pk text;
  ix record;
  p record;
begin
  foreach t in array array[
    'agent', 'answers', 'call_keys', 'companies', 'company_candidates', 'email_sync', 'emails',
    'experience', 'google_tokens', 'jobs', 'outreach', 'profile', 'runs', 'search_config', 'site_accounts'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;

    -- 2. Required, and tied to the login.
    execute format('alter table public.%I alter column user_id set not null', t);
    if not exists (select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass and conname = t || '_user_id_fkey') then
      execute format('alter table public.%I add constraint %I foreign key (user_id) references auth.users(id) on delete cascade', t, t || '_user_id_fkey');
    end if;

    -- 4. The old rules go, each only where its twin is in place.
    for ix in
      select c.relname as name
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid = format('public.%I', t)::regclass
        and i.indisunique and not i.indisprimary
        and not exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'user_id')
    loop
      if to_regclass(format('public.%I', left(ix.name, 55) || '_per_user')) is null then
        raise exception 'the rule % on % has no per-person twin; stopping before it is removed', ix.name, t;
      end if;
      if exists (select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass and conname = ix.name) then
        execute format('alter table public.%I drop constraint %I', t, ix.name);
      else
        execute format('drop index public.%I', ix.name);
      end if;
    end loop;

    -- 5. A person's own, and nobody else's. call_keys keeps no rule at all:
    -- only the panel's server reads it.
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    if t <> 'call_keys' then
      execute format(
        'create policy own_rows on public.%I for all to authenticated ' ||
        'using (user_id = (select public.app_uid()) and (select public.is_active_member())) ' ||
        'with check (user_id = (select public.app_uid()) and (select public.is_active_member()))', t);
    end if;
  end loop;

  -- 3. One row per person in the one-row tables: the key moves from "row 1"
  -- to "this person's row". Every person's row is still numbered 1, so
  -- everything that asks for row 1 goes on getting its own.
  foreach t in array array['agent', 'call_keys', 'email_sync', 'google_tokens', 'profile', 'search_config'] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    select conname into pk from pg_constraint where conrelid = format('public.%I', t)::regclass and contype = 'p';
    if pk is not null and not exists (
      select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
      where i.indrelid = format('public.%I', t)::regclass and i.indisprimary and a.attname = 'user_id') then
      execute format('alter table public.%I drop constraint %I', t, pk);
      execute format('alter table public.%I add constraint %I primary key using index %I', t, t || '_pkey', t || '_one_per_user');
    end if;
  end loop;
end $$;

-- The key to the writing model: the same rule as everything else.
do $$
begin
  if to_regclass('public.user_keys') is not null then
    drop policy if exists user_keys_own on public.user_keys;
    create policy user_keys_own on public.user_keys for all to authenticated
      using (user_id = (select public.app_uid()) and (select public.is_active_member()))
      with check (user_id = (select public.app_uid()) and (select public.is_active_member()));
  end if;
end $$;

-- Where a town is on the map is nobody's secret and everybody's saving.
drop policy if exists owner_all on public.geo_cache;
drop policy if exists shared_places on public.geo_cache;
create policy shared_places on public.geo_cache for all to authenticated
  using ((select public.is_active_member())) with check ((select public.is_active_member()));

-- A person's own files: their own folder in the private store. The owner's
-- rule over the whole store stands, which is also how the runner fetches a
-- person's resume when it is doing their round.
drop policy if exists "members manage own artifacts" on storage.objects;
create policy "members manage own artifacts" on storage.objects for all to authenticated
  using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = 'u' and (storage.foldername(name))[2] = auth.uid()::text and (select public.is_active_member()))
  with check (bucket_id = 'artifacts' and (storage.foldername(name))[1] = 'u' and (storage.foldername(name))[2] = auth.uid()::text and (select public.is_active_member()));

-- 6. Functions that looked for "the" settings.
create or replace function public.route_scored_job()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg record;
begin
  if new.score is null or new.score is not distinct from old.score then
    return new;
  end if;
  -- The thresholds of whoever the posting belongs to.
  select * into cfg from public.search_config where user_id = new.user_id;
  if not found then
    return new;
  end if;
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

create or replace function public.sync_job_from_email()
returns trigger
language plpgsql
as $$
begin
  if new.job_id is null or new.direction <> 'in' then
    return new;
  end if;
  if new.category = 'offer' then
    update jobs set status = 'offer' where id = new.job_id and user_id = new.user_id;
  elsif new.category = 'interview' then
    update jobs set status = 'interview' where id = new.job_id and user_id = new.user_id and status <> 'offer';
  elsif new.category = 'rejection' then
    update jobs set status = 'rejected' where id = new.job_id and user_id = new.user_id and status not in ('offer', 'interview');
  elsif new.category = 'confirmation' then
    update jobs
       set status = 'applied', help_reason = null,
           applied_at = coalesce(applied_at, new.received_at, now()), last_error = null
     where id = new.job_id and user_id = new.user_id and status = 'needs_help' and help_reason = 'unconfirmed';
    update jobs
       set confirm_state = 'confirmed', confirmed_at = coalesce(confirmed_at, new.received_at, now())
     where id = new.job_id and user_id = new.user_id;
  end if;
  return new;
end $$;

create or replace function public.claim_next_job()
returns table(id uuid, url text, apply_url text, title text, company text, ats text, score integer, tailored_resume text, description text)
language plpgsql
set search_path = public
as $$
declare
  me uuid := public.app_uid();
  cap int;
  done int;
begin
  if me is null then
    return;
  end if;
  select daily_cap into cap from public.search_config where search_config.user_id = me;
  select count(*) into done from public.jobs where jobs.user_id = me and applied_at::date = current_date;
  if done >= cap then
    return;
  end if;
  return query
  with picked as (
    select j.id from public.jobs j
    where j.user_id = me and j.status = 'queued' and j.attempts < 3
    order by j.score desc nulls last, j.found_at asc
    limit 1
    for update skip locked
  )
  update public.jobs j
     set status = 'applying', attempts = j.attempts + 1, updated_at = now()
    from picked
   where j.id = picked.id
  returning j.id, j.url, j.apply_url, j.title, j.company, j.ats, j.score, j.tailored_resume, j.description;
end $$;

create or replace function public.applications_today()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::int from jobs where user_id = public.app_uid() and applied_at >= date_trunc('day', now());
$$;

do $$
begin
  -- find_answer leans on an extension that may not be in every copy of this
  -- database; where it is, it answers from the asker's own answers only.
  if to_regprocedure('public.find_answer(text)') is not null and to_regprocedure('extensions.similarity(text,text)') is not null then
    execute $f$
      create or replace function public.find_answer(q text)
      returns table(answer text, confirmed boolean, similarity real)
      language sql stable set search_path = public, extensions
      as $body$
        select a.answer, a.confirmed, extensions.similarity(a.q_key, lower(trim(q))) as sim
        from public.answers a
        where a.user_id = public.app_uid()
          and (a.q_key = lower(trim(q)) or extensions.similarity(a.q_key, lower(trim(q))) > 0.75)
        order by (a.q_key = lower(trim(q))) desc, sim desc
        limit 1;
      $body$
    $f$;
  end if;
end $$;

-- 7. A workspace: the rows a person's panel expects to find, and a first
-- list of employers so that it does not start empty — the boards the owner's
-- workspace has already found. Those are public addresses of public job
-- boards; nothing of the owner's own goes with them.
create or replace function public.make_workspace(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := (select user_id from app_owner limit 1);
  nm text;
  em text;
begin
  select full_name, email into nm, em from members where user_id = p_user;
  insert into profile (id, user_id, full_name, email) values (1, p_user, nm, em) on conflict (user_id) do nothing;
  insert into search_config (id, user_id) values (1, p_user) on conflict (user_id) do nothing;
  insert into email_sync (id, user_id) values (1, p_user) on conflict (user_id) do nothing;
  insert into agent (id, user_id) values (1, p_user) on conflict (user_id) do nothing;
  if p_user <> owner and not exists (select 1 from companies where user_id = p_user) then
    insert into companies (user_id, name, ats, token, enabled, pod, site, careers_url)
    select p_user, name, ats, token, true, pod, site, careers_url
    from companies where user_id = owner and enabled is not false
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.make_workspace(uuid) from public, anon, authenticated;

-- Called by the panel when a person comes in. Does nothing for a login that
-- is not the owner's or approved.
create or replace function public.ensure_workspace()
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if not public.is_active_member() then
    return 'not approved';
  end if;
  perform public.make_workspace(auth.uid());
  return 'ready';
end $$;
revoke all on function public.ensure_workspace() from public, anon;
grant execute on function public.ensure_workspace() to authenticated;

-- The owner empties a person's workspace: everything that was theirs goes,
-- their login, name and email stay, and a fresh workspace is made. Never
-- the owner's own: that is not something to do by pressing a button.
create or replace function public.admin_reset_workspace(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
begin
  if not public.is_app_owner() then
    raise exception 'owner only';
  end if;
  if exists (select 1 from app_owner where user_id = p_user) or not exists (select 1 from members where user_id = p_user) then
    raise exception 'not a person on the list';
  end if;
  foreach t in array array[
    'outreach', 'emails', 'site_accounts', 'answers', 'experience', 'runs', 'jobs', 'company_candidates', 'companies',
    'agent', 'email_sync', 'google_tokens', 'call_keys', 'search_config', 'profile', 'user_keys'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('delete from public.%I where user_id = $1', t) using p_user;
    end if;
  end loop;
  perform public.make_workspace(p_user);
  return 'emptied';
end $$;
revoke all on function public.admin_reset_workspace(uuid) from public, anon;
grant execute on function public.admin_reset_workspace(uuid) to authenticated;

-- So the runner can tell that each person's round may now be done.
create or replace function public.workspaces_ready()
returns boolean language sql stable as $$ select true $$;
grant execute on function public.workspaces_ready() to authenticated;

notify pgrst, 'reload schema';
