ALTER TABLE public.site_accounts
  ADD COLUMN IF NOT EXISTS session_state jsonb,
  ADD COLUMN IF NOT EXISTS session_updated_at timestamptz;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS apply_mode text;

COMMENT ON COLUMN public.site_accounts.session_state IS 'Optional Playwright storageState/cookies JSON for authenticated job board sessions (LinkedIn, Indeed, ZipRecruiter).';
COMMENT ON COLUMN public.site_accounts.session_updated_at IS 'Timestamp when session_state was last captured or refreshed.';
COMMENT ON COLUMN public.jobs.apply_mode IS 'Detected application workflow mode: easy_apply, external, or native.';