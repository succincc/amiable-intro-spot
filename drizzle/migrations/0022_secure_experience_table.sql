GRANT SELECT, INSERT, UPDATE, DELETE ON public.experience TO authenticated;
GRANT ALL ON public.experience TO service_role;
REVOKE ALL ON public.experience FROM anon;

DROP POLICY IF EXISTS owner_all ON public.experience;
CREATE POLICY owner_all ON public.experience
  FOR ALL
  TO authenticated
  USING (public.is_app_owner())
  WITH CHECK (public.is_app_owner());