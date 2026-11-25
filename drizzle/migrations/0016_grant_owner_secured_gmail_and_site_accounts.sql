GRANT SELECT, INSERT, UPDATE, DELETE ON public.site_accounts, public.google_tokens TO authenticated;
GRANT ALL ON public.site_accounts, public.google_tokens TO service_role;
REVOKE ALL ON public.site_accounts, public.google_tokens FROM anon;
