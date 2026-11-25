-- ============================================================================
-- Gmail access, stored once
--
-- The Apps Script bridge works, but it has to be installed by hand at
-- script.google.com — which is the one step in this whole system that cannot
-- be done from a phone, and so never got done. The inbox has stayed empty,
-- which is why the dashboard can say "4 sent / 0 confirmed" without that
-- telling anyone whether those four landed.
--
-- OAuth replaces it with a button. It also unlocks two things the bridge
-- could not reach cleanly: the verification codes Workday emails before a new
-- account works, and sending from the address that applied.
-- ============================================================================

create table if not exists google_tokens (
  id            int primary key default 1,
  -- The mailbox this grant is for. Shown in the panel so it is obvious which
  -- account is connected, and checked on reconnect.
  email         text,
  -- The long-lived one. Google issues it once, at first consent, and not
  -- again on later grants unless prompt=consent is forced — so it is never
  -- overwritten with null.
  refresh_token text,
  access_token  text,
  expires_at    timestamptz,
  scope         text,
  connected_at  timestamptz default now(),
  last_sync_at  timestamptz,
  last_error    text,
  constraint google_tokens_single_row check (id = 1)
);

insert into google_tokens (id) values (1) on conflict (id) do nothing;

alter table google_tokens enable row level security;
drop policy if exists owner_all on google_tokens;
create policy owner_all on google_tokens for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Which message have we already read?
-- ---------------------------------------------------------------------------
-- Gmail's history API needs a starting point, and re-reading the whole
-- mailbox on every sync would burn the quota and re-classify mail that has
-- already been filed. email_sync already tracks this for the bridge; this
-- adds the Gmail-specific cursor beside it so the two can coexist while the
-- bridge is retired.
alter table email_sync add column if not exists gmail_history_id text;
alter table email_sync add column if not exists source text default 'bridge';
