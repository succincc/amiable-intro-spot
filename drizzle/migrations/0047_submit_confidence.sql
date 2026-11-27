-- How sure the record is that an application arrived, said outright.
--
-- "Applied" has meant one thing on the page and three in fact:
--   confirmed  - the employer said so: a receipt in the mailbox, or any
--                reply about the application (a rejection is proof of
--                arrival as much as an invitation is);
--   probable   - the portal showed its own confirmation page to the applier
--                and nothing has come from the employer since;
--   unverified - the form was sent and no confirmation was seen at all.
-- An audit of 155 applications found 100 of the first kind and 55 of the
-- second. Worked out from the row itself, so it cannot fall out of step.
alter table public.jobs add column if not exists submit_confidence text
  generated always as (
    case
      when confirm_state = 'confirmed' or status in ('interview', 'offer', 'rejected') then 'confirmed'
      when status = 'applied' then 'probable'
      when help_reason = 'unconfirmed' then 'unverified'
      else null
    end
  ) stored;
create index if not exists idx_jobs_submit_confidence on public.jobs(submit_confidence);

create or replace function public.sync_job_from_email()
returns trigger
language plpgsql
as $$
declare
  was_job uuid;
  was_cat text;
begin
  -- First, down: a mail that used to say "interview" or "offer" about a job
  -- and no longer does (read again as something else, or no longer about
  -- that job) takes the job back with it, unless another mail still says so.
  if tg_op = 'UPDATE' and old.job_id is not null and old.direction = 'in'
     and old.category in ('interview', 'offer')
     and (new.category is distinct from old.category or new.job_id is distinct from old.job_id) then
    was_job := old.job_id;
    was_cat := old.category;
    update jobs j
       set status = case
             when was_cat = 'offer' and exists (
               select 1 from emails e where e.job_id = was_job and e.direction = 'in' and e.category = 'interview' and e.id <> new.id
             ) then 'interview'
             when exists (
               select 1 from emails e where e.job_id = was_job and e.direction = 'in' and e.category = 'rejection' and e.id <> new.id
             ) then 'rejected'
             else 'applied'
           end
     where j.id = was_job and j.status = was_cat
       and not exists (
         select 1 from emails e where e.job_id = was_job and e.direction = 'in' and e.category = was_cat and e.id <> new.id
       );
  end if;

  -- A receipt put with a different application (spreadReceipts) takes its
  -- confirmation with it, unless the one it leaves has another.
  if tg_op = 'UPDATE' and old.job_id is not null and new.job_id is distinct from old.job_id
     and old.direction = 'in' and (old.category = 'confirmation' or old.kind = 'acknowledgement') then
    update jobs j
       set confirm_state = 'pending', confirmed_at = null
     where j.id = old.job_id and j.confirm_state = 'confirmed'
       and not exists (
         select 1 from emails e where e.job_id = old.job_id and e.direction = 'in' and e.id <> new.id
            and (e.category = 'confirmation' or e.kind = 'acknowledgement')
       );
  end if;

  if new.job_id is null or new.direction <> 'in' then
    return new;
  end if;
  if new.category = 'offer' then
    update jobs set status = 'offer' where id = new.job_id and user_id = new.user_id;
  elsif new.category = 'interview' then
    update jobs set status = 'interview' where id = new.job_id and user_id = new.user_id and status <> 'offer';
  elsif new.category = 'rejection' then
    update jobs set status = 'rejected' where id = new.job_id and user_id = new.user_id and status not in ('offer', 'interview');
  elsif new.category = 'confirmation' or new.kind = 'acknowledgement' then
    -- A receipt is a receipt whichever category it was filed under: nine of
    -- them sat under "action_needed" because they also asked for an email
    -- address to be verified, and their jobs stayed unconfirmed.
    update jobs
       set status = 'applied', help_reason = null,
           applied_at = coalesce(applied_at, new.received_at, now()), last_error = null
     where id = new.job_id and user_id = new.user_id and status = 'needs_help' and help_reason = 'unconfirmed';
    update jobs
       set confirm_state = 'confirmed', confirmed_at = coalesce(confirmed_at, new.received_at, now())
     where id = new.job_id and user_id = new.user_id;
  end if;
  return new;
end $$;


notify pgrst, 'reload schema';
