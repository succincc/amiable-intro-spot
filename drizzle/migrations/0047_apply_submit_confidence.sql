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