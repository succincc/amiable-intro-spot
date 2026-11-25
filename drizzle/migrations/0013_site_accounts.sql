-- ============================================================================
-- Accounts the applier creates on employer portals
--
-- Workday, and several others, will not show an application form until you
-- have registered. The applier used to stop dead at the first password field
-- and park the job as needs_help, which rules out most large employers —
-- exactly the ones worth applying to.
--
-- ON PASSWORDS
--
-- The obvious shortcut is to reuse the panel's own password everywhere. That
-- is the one thing not to do. The panel holds the resume, the contact
-- details, the saved answers and the inbox; employer ATS instances are
-- breached routinely, and reusing it means any one of a few hundred portals
-- leaking hands someone all of it.
--
-- So each site gets its own generated password. The blast radius of a breach
-- is one employer account containing a resume that was sent to them anyway.
--
-- These are stored readable, like every other credential this system holds,
-- because the applier has to type them back in. The row is protected by the
-- same owner-only policy as the resume and the inbox. Anyone with the
-- database has those already; the per-site passwords add no new exposure,
-- while reusing one password would have.
-- ============================================================================

create table if not exists site_accounts (
  id          uuid primary key default gen_random_uuid(),
  -- The portal host, e.g. "target.wd5.myworkdayjobs.com". One account per
  -- host: Workday scopes a login to its tenant, not to a single posting.
  host        text not null unique,
  email       text not null,
  password    text not null,
  -- pending_verification | active | failed
  status      text not null default 'active',
  note        text,
  job_id      uuid references jobs(id) on delete set null,
  created_at  timestamptz default now(),
  last_used_at timestamptz
);

alter table site_accounts drop constraint if exists site_accounts_status_check;
alter table site_accounts add constraint site_accounts_status_check
  check (status in ('pending_verification', 'active', 'failed'));

create index if not exists idx_site_accounts_host on site_accounts(host);

alter table site_accounts enable row level security;
drop policy if exists owner_all on site_accounts;
create policy owner_all on site_accounts for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Let the applier decide whether to register at all
-- ---------------------------------------------------------------------------
-- Creating accounts on employer systems is a real-world side effect, and the
-- kind of thing that should be switched on deliberately rather than inherited
-- from a default — the same lesson as autopilot.
alter table profile add column if not exists create_accounts boolean default false;
