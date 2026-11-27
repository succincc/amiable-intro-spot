-- The list of employers is one list, for everybody.
--
-- Finding out which hiring system each of a couple of thousand employers
-- runs on is slow work with a browser, and its result is the same whoever
-- asks. It was being kept per person, so a new workspace started with none
-- of it and would have had to do all of it again.
--
--   company_candidates   the employers being looked into, and what was
--                        found: one shared list. Everybody with a workspace
--                        can read it; only the owner (and so the runner)
--                        adds to it or changes it.
--   companies            the job boards each person's own search reads.
--                        Still a list per person — each search keeps its own
--                        place in it — but every board the owner's list
--                        gains is copied into everyone's, automatically.
--
-- Safe to run twice.

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'company_candidates' loop
    execute format('drop policy %I on public.company_candidates', p.policyname);
  end loop;
end $$;
create policy catalogue_read on public.company_candidates for select to authenticated
  using ((select public.is_active_member()));
create policy catalogue_owner on public.company_candidates for all to authenticated
  using ((select public.is_app_owner())) with check ((select public.is_app_owner()));

-- Every board the owner's list has, into the list of one person or of
-- everyone with a workspace. What a person already has is left as it is,
-- switched off or on.
create or replace function public.catalogue_sync(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := (select user_id from app_owner limit 1);
  n integer;
begin
  insert into companies (user_id, name, ats, token, enabled, pod, site, careers_url)
  select w.user_id, c.name, c.ats, c.token, true, c.pod, c.site, c.careers_url
  from companies c
  join profile w on w.user_id <> owner and (p_user is null or w.user_id = p_user)
  where c.user_id = owner and c.enabled is not false
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.catalogue_sync(uuid) from public, anon, authenticated;
grant execute on function public.catalogue_sync(uuid) to service_role;

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
  -- Every time a person comes in, not only the first: whatever the shared
  -- list has gained since is theirs too.
  if p_user <> owner then
    perform public.catalogue_sync(p_user);
  end if;
end $$;
revoke all on function public.make_workspace(uuid) from public, anon, authenticated;