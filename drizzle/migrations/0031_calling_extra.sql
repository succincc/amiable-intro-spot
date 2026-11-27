create table if not exists public.call_keys (
  id int primary key default 1,
  voice_key text,
  voice_id text,
  phone_sid text,
  phone_token text,
  phone_number text,
  updated_at timestamptz not null default now()
);
grant all on public.call_keys to service_role;
revoke all on public.call_keys from anon, authenticated;
alter table public.call_keys enable row level security;
alter table public.profile add column if not exists calls_enabled boolean not null default false;
alter table public.profile add column if not exists calls_min_score int not null default 7;
alter table public.profile add column if not exists calls_targets_only boolean not null default false;