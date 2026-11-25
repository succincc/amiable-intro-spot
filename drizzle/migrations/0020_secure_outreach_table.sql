GRANT SELECT, INSERT, UPDATE, DELETE ON public.outreach TO authenticated;
GRANT ALL ON public.outreach TO service_role;
REVOKE ALL ON public.outreach FROM anon;

DROP POLICY IF EXISTS owner_all ON public.outreach;
CREATE POLICY owner_all ON public.outreach
  FOR ALL
  TO authenticated
  USING (public.is_app_owner())
  WITH CHECK (public.is_app_owner());