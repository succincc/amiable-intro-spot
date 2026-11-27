CREATE OR REPLACE FUNCTION public.admin_reset_workspace(p_user uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_app_owner() THEN
    RAISE EXCEPTION 'owner only';
  END IF;
  IF p_user IS NULL
     OR EXISTS (SELECT 1 FROM public.app_owner WHERE user_id = p_user)
     OR NOT EXISTS (SELECT 1 FROM public.members WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'not a person on the list';
  END IF;

  DELETE FROM public.outreach WHERE user_id = p_user;
  DELETE FROM public.emails WHERE user_id = p_user;
  DELETE FROM public.site_accounts WHERE user_id = p_user;
  DELETE FROM public.answers WHERE user_id = p_user;
  DELETE FROM public.experience WHERE user_id = p_user;
  DELETE FROM public.runs WHERE user_id = p_user;
  DELETE FROM public.jobs WHERE user_id = p_user;
  DELETE FROM public.company_candidates WHERE user_id = p_user;
  DELETE FROM public.companies WHERE user_id = p_user;
  DELETE FROM public.agent WHERE user_id = p_user;
  DELETE FROM public.email_sync WHERE user_id = p_user;
  DELETE FROM public.google_tokens WHERE user_id = p_user;
  DELETE FROM public.call_keys WHERE user_id = p_user;
  DELETE FROM public.search_config WHERE user_id = p_user;
  DELETE FROM public.profile WHERE user_id = p_user;
  DELETE FROM public.user_keys WHERE user_id = p_user;

  PERFORM public.make_workspace(p_user);
  RETURN 'emptied';
END $$;
REVOKE ALL ON FUNCTION public.admin_reset_workspace(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reset_workspace(uuid) TO authenticated;

-- Regression probe: no anonymous request can reach the deletion statements.
DO $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'security probe requires an unauthenticated migration session';
  END IF;
  BEGIN
    PERFORM public.admin_reset_workspace(NULL);
    RAISE EXCEPTION 'security probe failed: anonymous reset accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'owner only' THEN
      RAISE;
    END IF;
  END;
END $$;