GRANT SELECT, INSERT, UPDATE, DELETE ON public.geo_cache TO authenticated;
GRANT ALL ON public.geo_cache TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_sync TO authenticated;
GRANT ALL ON public.email_sync TO service_role;
GRANT SELECT ON public.v_inbox, public.v_email_stats, public.v_stats TO authenticated;