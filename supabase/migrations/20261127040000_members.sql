-- People asking to use the panel, and the owner's yes or no.
--
-- Signing up makes a login and a row here marked 'pending'. Nothing else in
-- the database opens to that login: every table of the owner's is readable
-- by the owner alone, and stays so. The owner approves or denies from the
-- panel; a person can read only their own row.
--
-- Two tables made after the owner-only rule was laid down had been left
-- readable by any signed-in login. With one account that was invisible; with
-- sign-ups it would have shown the owner's experience notes and outreach to
-- anyone who registered. Both are closed here, before sign-ups open.

do $$
begin
  if to_regprocedure('public.is_app_owner()') is null then
    raise exception 'public.is_app_owner() is missing — apply the owner-restriction migration first.';
  end if;
end $$;

create table if not exists members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table members enable row level security;

drop policy if exists members_read on members;
create policy members_read on members for select to authenticated
  using (user_id = auth.uid() or public.is_app_owner());
drop policy if exists members_owner_update on members;
create policy members_owner_update on members for update to authenticated
  using (public.is_app_owner()) with check (public.is_app_owner());
drop policy if exists members_owner_delete on members;
create policy members_owner_delete on members for delete to authenticated
  using (public.is_app_owner());

-- The one way a row is made: by the person themselves, as 'pending', never
-- as anything else. Returns where they stand: owner, approved, pending or
-- denied. Asking again changes nothing.
create or replace function public.request_access(p_full_name text default '')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  st text;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if public.is_app_owner() then
    return 'owner';
  end if;
  insert into members (user_id, email, full_name)
  values (
    auth.uid(),
    coalesce((select email from auth.users where id = auth.uid()), ''),
    left(coalesce(nullif(trim(p_full_name), ''), (select raw_user_meta_data ->> 'full_name' from auth.users where id = auth.uid()), ''), 120)
  )
  on conflict (user_id) do nothing;
  select status into st from members where user_id = auth.uid();
  return st;
end $$;
revoke all on function public.request_access(text) from public;
grant execute on function public.request_access(text) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['outreach', 'experience'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists owner_all on public.%I', t);
      execute format(
        'create policy owner_all on public.%I for all to authenticated ' ||
        'using (public.is_app_owner()) with check (public.is_app_owner())', t);
    end if;
  end loop;
end $$;
