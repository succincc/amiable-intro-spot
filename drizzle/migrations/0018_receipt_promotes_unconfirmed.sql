-- ============================================================================
-- A receipt settles an application nobody saw confirmed
--
-- The applier files a job as needs_help/'unconfirmed' when it pressed Submit
-- and the portal showed no confirmation it recognised. MongoDB did exactly
-- that twice: the applications were accepted, the employer's "Thank you for
-- applying" arrived in the inbox minutes later, and the jobs stayed in the
-- backlog as if nothing had been sent.
--
-- The receipt is the evidence that was missing. When a confirmation email is
-- matched to a job in that one state, the job becomes 'applied'. Nothing else
-- is promoted: a job stopped for a missing field, a login wall or a CAPTCHA
-- was never submitted, and a receipt matched to it by company name belongs to
-- some other application.
-- ============================================================================

create or replace function sync_job_from_email() returns trigger as $$
begin
  if new.job_id is null or new.direction <> 'in' then
    return new;
  end if;

  if new.category = 'offer' then
    update jobs set status = 'offer' where id = new.job_id;

  elsif new.category = 'interview' then
    update jobs set status = 'interview'
      where id = new.job_id and status <> 'offer';

  elsif new.category = 'rejection' then
    update jobs set status = 'rejected'
      where id = new.job_id and status not in ('offer','interview');

  elsif new.category = 'confirmation' then
    update jobs
       set status      = 'applied',
           help_reason = null,
           applied_at  = coalesce(applied_at, new.received_at, now()),
           last_error  = null
     where id = new.job_id
       and status = 'needs_help'
       and help_reason = 'unconfirmed';

    update jobs
       set confirm_state = 'confirmed',
           confirmed_at  = coalesce(confirmed_at, new.received_at, now())
     where id = new.job_id;
  end if;

  return new;
end;
$$ language plpgsql;

-- The receipts already in the inbox for jobs filed that way.
update jobs j
   set status        = 'applied',
       help_reason   = null,
       applied_at    = coalesce(j.applied_at, e.received_at, now()),
       confirm_state = 'confirmed',
       confirmed_at  = coalesce(j.confirmed_at, e.received_at, now()),
       last_error    = null
  from emails e
 where e.job_id = j.id
   and e.direction = 'in'
   and e.category = 'confirmation'
   and j.status = 'needs_help'
   and j.help_reason = 'unconfirmed';
