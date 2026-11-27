-- Calling, as an optional extra each user pays their own provider for.
--
-- The keys to a user's own phone and voice accounts are kept where only the
-- panel's server can read them: the table has row level security on and no
-- policy, the same as the mailbox tokens. The page is told only whether
-- they are set.
--
-- The rule for when to call sits on the profile, off unless switched on.

create table if not exists call_keys (
  id            int primary key default 1,
  voice_key     text,
  voice_id      text,
  phone_sid     text,
  phone_token   text,
  phone_number  text,
  updated_at    timestamptz not null default now()
);
alter table call_keys enable row level security;

alter table profile add column if not exists calls_enabled boolean not null default false;
alter table profile add column if not exists calls_min_score int not null default 7;
alter table profile add column if not exists calls_targets_only boolean not null default false;
