alter table public.jobs add column if not exists phone text;
alter table public.jobs add column if not exists call_state text;
alter table public.jobs add column if not exists call_note text;
alter table public.jobs add column if not exists call_at timestamptz;