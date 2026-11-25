DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','email_sync','geo_cache'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', t);
    EXECUTE format('CREATE POLICY owner_all ON public.%I FOR ALL TO authenticated USING (public.is_app_owner()) WITH CHECK (public.is_app_owner())', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS "Authenticated manage artifacts" ON storage.objects;
DROP POLICY IF EXISTS "owner reads artifacts" ON storage.objects;
DROP POLICY IF EXISTS "owner updates artifacts" ON storage.objects;
DROP POLICY IF EXISTS "owner writes artifacts" ON storage.objects;
CREATE POLICY "app owner manages artifacts" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'artifacts' AND public.is_app_owner())
  WITH CHECK (bucket_id = 'artifacts' AND public.is_app_owner());