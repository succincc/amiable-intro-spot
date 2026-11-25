-- A short email after an application, from the owner's own Gmail.
--
-- Once an application has gone in, the applier can write to the employer's
-- published contact address: which role was applied for, why the owner fits
-- it, and the resume that was sent with the application attached. One per
-- employer, never to an address that was guessed, and only when this is
-- switched on.
--
-- Off by default. It sends mail under the owner's name with nobody reading
-- it first, which should be a decision and not an inherited default.

alter table profile add column if not exists follow_up boolean default false;

create table if not exists outreach (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references jobs(id) on delete set null,
  company     text not null,
  to_addr     text,
  -- where on the employer's own site the address was published
  found_on    text,
  subject     text,
  body        text,
  -- sent: it went. failed: Gmail refused it. skipped: no published address,
  -- or the employer was written to recently. dry: written but not sent.
  state       text not null default 'dry',
  reason      text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

alter table outreach drop constraint if exists outreach_state_check;
alter table outreach add constraint outreach_state_check
  check (state in ('sent','failed','skipped','dry'));

create index if not exists idx_outreach_job     on outreach(job_id);
create index if not exists idx_outreach_company on outreach(lower(company), created_at desc);
create index if not exists idx_outreach_sent    on outreach(sent_at desc) where state = 'sent';

alter table outreach enable row level security;
drop policy if exists owner_all on outreach;
create policy owner_all on outreach for all to authenticated using (true) with check (true);