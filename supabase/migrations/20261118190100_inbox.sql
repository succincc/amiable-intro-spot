-- ============================================================================
-- The inbox: employer replies, sorted, matched to the application, answered
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- emails: enough to show a thread, draft a reply, and prove it was sent
-- ---------------------------------------------------------------------------
alter table emails add column if not exists thread_id    text;
alter table emails add column if not exists to_addr      text;
alter table emails add column if not exists direction    text default 'in';
alter table emails add column if not exists confidence   text default 'high';
alter table emails add column if not exists classify_why text;
alter table emails add column if not exists reply_draft  text;
alter table emails add column if not exists reply_state  text default 'none';
alter table emails add column if not exists replied_at   timestamptz;
alter table emails add column if not exists reply_error  text;

alter table emails drop constraint if exists emails_direction_check;
alter table emails add constraint emails_direction_check
  check (direction in ('in','out'));

-- none     : no reply wanted (a rejection, a receipt, a no-reply sender)
-- draft    : written, waiting to be looked at
-- approved : cleared to go — the bridge sends it on its next run
-- sent     : gone
-- failed   : the bridge tried and could not; reply_error says why
alter table emails drop constraint if exists emails_reply_state_check;
alter table emails add constraint emails_reply_state_check
  check (reply_state in ('none','draft','approved','sent','failed'));

create index if not exists idx_emails_received on emails(received_at desc);
create index if not exists idx_emails_category on emails(category);
create index if not exists idx_emails_reply    on emails(reply_state);

-- ---------------------------------------------------------------------------
-- Where the Gmail bridge keeps its place
-- ---------------------------------------------------------------------------
-- Without a cursor the bridge either re-reads the whole mailbox every run or
-- loses mail when a run fails.
create table if not exists email_sync (
  id           int primary key default 1,
  last_seen_at timestamptz,
  last_run_at  timestamptz,
  last_status  text,
  last_error   text,
  seen_count   int default 0,
  constraint email_sync_single_row check (id = 1)
);
insert into email_sync (id) values (1) on conflict (id) do nothing;

alter table email_sync enable row level security;
drop policy if exists owner_all on email_sync;
create policy owner_all on email_sync for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
-- Deliberately NOT adding a separate contact_email: profile.email is already
-- the address the applier types into employer forms, and auth owns the login
-- address. A third field that means the same thing as profile.email would
-- just be one more place for them to disagree.
--
-- Off by default. Turning it on lets replies go out with nobody reading them
-- first — which is the point, but it should be a decision, not an inherited
-- default.
alter table profile add column if not exists auto_reply boolean default false;

-- ---------------------------------------------------------------------------
-- views
-- ---------------------------------------------------------------------------
create or replace view v_inbox as
select
  e.id, e.message_id, e.thread_id, e.from_addr, e.subject, e.snippet,
  e.received_at, e.category, e.confidence, e.classify_why,
  e.is_read, e.reply_draft, e.reply_state, e.replied_at, e.reply_error,
  e.job_id,
  j.title   as job_title,
  j.company as job_company,
  j.status  as job_status
from emails e
left join jobs j on j.id = e.job_id
where e.direction = 'in';

-- The confirmation gap is the most valuable number in the system. Every other
-- figure is the applier's own account of its own behaviour — it says it
-- applied, so the panel says applied. A receipt is the employer independently
-- confirming the application arrived. 40 claimed against 12 receipts means
-- the applier is broken, and nothing else can reveal that.
create or replace view v_email_stats as
select
  count(*) filter (where direction = 'in')                      as received,
  count(*) filter (where direction = 'in' and is_read = false)  as unread,
  count(*) filter (where category = 'interview')                as interviews,
  count(*) filter (where category = 'offer')                    as offers,
  count(*) filter (where category = 'rejection')                as rejections,
  count(*) filter (where category = 'action_needed')            as action_needed,
  count(*) filter (where category = 'confirmation')             as confirmations,
  count(*) filter (where category = 'other')                    as other,
  count(*) filter (where reply_state = 'draft')                 as drafts_waiting,
  count(*) filter (where reply_state = 'sent')                  as replies_sent,
  count(*) filter (where reply_state = 'failed')                as replies_failed,
  (select count(*) from jobs
    where status in ('applied','interview','offer','rejected'))  as applications_sent,
  (select count(*) from emails where category = 'confirmation')  as applications_confirmed
from emails;

-- ---------------------------------------------------------------------------
-- An email that lands on a job should move the job
-- ---------------------------------------------------------------------------
-- An interview invitation that leaves the job at 'applied' makes the pipeline
-- on the dashboard a lie, and knowing where things actually stand is the
-- whole reason for reading the mail.
create or replace function sync_job_from_email() returns trigger as $$
begin
  if new.job_id is null or new.direction <> 'in' then
    return new;
  end if;

  if new.category = 'offer' then
    update jobs set status = 'offer' where id = new.job_id;

  elsif new.category = 'interview' then
    -- Never walk a job backwards: a stray interview mail arriving after an
    -- offer must not demote the offer.
    update jobs set status = 'interview'
      where id = new.job_id and status <> 'offer';

  elsif new.category = 'rejection' then
    update jobs set status = 'rejected'
      where id = new.job_id and status not in ('offer','interview');

  elsif new.category = 'confirmation' then
    update jobs
       set confirm_state = 'confirmed',
           confirmed_at  = coalesce(confirmed_at, new.received_at, now())
     where id = new.job_id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sync_job_from_email on emails;
create trigger trg_sync_job_from_email
  after insert or update of category on emails
  for each row execute function sync_job_from_email();
