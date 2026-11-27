alter table public.call_keys add column if not exists agent_id text;
alter table public.call_keys add column if not exists phone_id text;
alter table public.jobs add column if not exists call_ref text;