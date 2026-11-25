ALTER TABLE public.companies
  ADD CONSTRAINT companies_ats_token_site_key UNIQUE NULLS NOT DISTINCT (ats, token, site);