-- ============================================================================
-- Close the last three tables that any signed-in user could read
--
-- Earlier migrations restricted most tables to is_app_owner(), but three were
-- created afterwards and kept the original `using (true)` policy — which
-- means ANY authenticated user, not just the owner.
--
-- With one account that is invisible. It stops being invisible the moment a
-- second person signs up, and these three are the worst ones to leave open:
--
--   site_accounts       every generated employer portal password
--   google_tokens       the refresh token to the owner's Gmail
--   company_candidates  less sensitive, but there is no reason to share it
--
-- A second signup would have read all of it. This is cheap now and
-- unrecoverable later, because by then the credentials have been seen.
-- ============================================================================

do $$
declare t text;
begin
  -- is_app_owner() is defined in an earlier migration. Guard anyway, so this
  -- cannot half-apply on a database built in a different order.
  if to_regprocedure('public.is_app_owner()') is null then
    raise exception 'public.is_app_owner() is missing — apply the owner-restriction migration first.';
  end if;

  foreach t in array array['site_accounts', 'google_tokens', 'company_candidates'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists owner_all on public.%I', t);
      execute format(
        'create policy owner_all on public.%I for all to authenticated ' ||
        'using (public.is_app_owner()) with check (public.is_app_owner())', t);
    end if;
  end loop;
end $$;
