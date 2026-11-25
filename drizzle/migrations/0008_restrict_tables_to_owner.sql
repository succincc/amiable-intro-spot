CREATE TABLE IF NOT EXISTS public.app_owner (
  user_id uuid PRIMARY KEY
);
GRANT SELECT ON public.app_owner TO authenticated;
GRANT ALL ON public.app_owner TO service_role;
ALTER TABLE public.app_owner ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_reads_self" ON public.app_owner FOR SELECT TO authenticated USING (user_id = auth.uid());
INSERT INTO public.app_owner(user_id) VALUES ('36b34da8-e6e4-4fcf-95c6-8e13b9c68b7a') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_app_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_owner WHERE user_id = auth.uid())
$$;
REVOKE EXECUTE ON FUNCTION public.is_app_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_owner() TO authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_config','agent','companies','runs','profile','emails','answers'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', t);
    EXECUTE format('CREATE POLICY owner_all ON public.%I FOR ALL TO authenticated USING (public.is_app_owner()) WITH CHECK (public.is_app_owner())', t);
  END LOOP;
END $$;