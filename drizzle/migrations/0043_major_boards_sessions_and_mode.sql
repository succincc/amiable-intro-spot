alter table public.site_accounts
  add column if not exists session_state jsonb,
  add column if not exists session_updated_at timestamptz;

alter table public.jobs
  add column if not exists apply_mode text;

comment on column public.site_accounts.session_state is 'Optional Playwright storageState/cookies JSON for authenticated job board sessions (LinkedIn, Indeed, ZipRecruiter).';
comment on column public.site_accounts.session_updated_at is 'Timestamp when session_state was last captured or refreshed.';
comment on column public.jobs.apply_mode is 'Detected application workflow mode: easy_apply, external, or native.';