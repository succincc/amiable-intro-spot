alter table public.jobs add column if not exists confirmation_status text;
alter table public.jobs add column if not exists confirmed_at timestamptz;