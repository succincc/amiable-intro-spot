CREATE TABLE IF NOT EXISTS public.company_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, careers_url text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending', ats text, token text, pod text, site text, resolved_url text, note text,
 checked_at timestamptz, created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_candidates TO authenticated;
GRANT ALL ON public.company_candidates TO service_role;
CREATE INDEX IF NOT EXISTS idx_candidates_status ON public.company_candidates(status);
ALTER TABLE public.company_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.company_candidates;
CREATE POLICY owner_all ON public.company_candidates FOR ALL TO authenticated USING (public.is_app_owner()) WITH CHECK (public.is_app_owner());
CREATE OR REPLACE VIEW public.v_candidate_stats WITH (security_invoker = true) AS
SELECT count(*) AS total, count(*) FILTER (WHERE status = 'pending') AS pending,
count(*) FILTER (WHERE status = 'ok') AS resolved, count(*) FILTER (WHERE status = 'failed') AS failed,
count(*) FILTER (WHERE status = 'skipped') AS skipped FROM public.company_candidates;
GRANT SELECT ON public.v_candidate_stats TO authenticated, service_role;