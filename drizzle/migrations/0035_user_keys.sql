-- Each person's own key to the free writing model.
--
-- The free allowance belongs to a key's Google account, and one account's is
-- spent by one person's applications. So each person brings their own, free,
-- and their resumes and answers are written on their own allowance. A row is
-- a person's own: readable and writable by them, and by the runner when it
-- is doing that person's round.

create table if not exists user_keys (
  user_id    uuid primary key default public.app_uid_or_owner() references auth.users(id) on delete cascade,
  gemini_key text,
  updated_at timestamptz not null default now()
);
alter table user_keys enable row level security;
drop policy if exists user_keys_own on user_keys;
create policy user_keys_own on user_keys for all to authenticated
  using (user_id = (select public.app_uid()))
  with check (user_id = (select public.app_uid()));