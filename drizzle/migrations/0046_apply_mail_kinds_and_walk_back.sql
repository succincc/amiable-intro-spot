alter table public.emails add column if not exists kind text;
create index if not exists idx_emails_kind on public.emails(kind);
create or replace function public.sync_job_from_email()
returns trigger language plpgsql as $$
declare was_job uuid; was_cat text;
begin
  if tg_op = 'UPDATE' and old.job_id is not null and old.direction = 'in'
     and old.category in ('interview', 'offer')
     and (new.category is distinct from old.category or new.job_id is distinct from old.job_id) then
    was_job := old.job_id;
    was_cat := old.category;
    update jobs j set status = case
      when was_cat = 'offer' and exists (select 1 from emails e where e.job_id = was_job and e.direction = 'in' and e.category = 'interview' and e.id <> new.id) then 'interview'
      when exists (select 1 from emails e where e.job_id = was_job and e.direction = 'in' and e.category = 'rejection' and e.id <> new.id) then 'rejected'
      else 'applied' end
    where j.id = was_job and j.status = was_cat
      and not exists (select 1 from emails e where e.job_id = was_job and e.direction = 'in' and e.category = was_cat and e.id <> new.id);
  end if;
  if new.job_id is null or new.direction <> 'in' then return new; end if;
  if new.category = 'offer' then
    update jobs set status = 'offer' where id = new.job_id and user_id = new.user_id;
  elsif new.category = 'interview' then
    update jobs set status = 'interview' where id = new.job_id and user_id = new.user_id and status <> 'offer';
  elsif new.category = 'rejection' then
    update jobs set status = 'rejected' where id = new.job_id and user_id = new.user_id and status not in ('offer', 'interview');
  elsif new.category = 'confirmation' or new.kind = 'acknowledgement' then
    update jobs set status = 'applied', help_reason = null,
      applied_at = coalesce(applied_at, new.received_at, now()), last_error = null
    where id = new.job_id and user_id = new.user_id and status = 'needs_help' and help_reason = 'unconfirmed';
    update jobs set confirm_state = 'confirmed', confirmed_at = coalesce(confirmed_at, new.received_at, now())
    where id = new.job_id and user_id = new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_job_from_email on public.emails;
create trigger trg_sync_job_from_email after insert or update of category, kind, job_id on public.emails
for each row execute function public.sync_job_from_email();
update jobs j set status = case
  when exists (select 1 from emails e where e.job_id = j.id and e.direction = 'in' and e.category = 'interview') then 'interview'
  when exists (select 1 from emails e where e.job_id = j.id and e.direction = 'in' and e.category = 'rejection') then 'rejected'
  else 'applied' end
where j.status = 'offer' and not exists (select 1 from emails e where e.job_id = j.id and e.direction = 'in' and e.category = 'offer');
update jobs j set status = case
  when exists (select 1 from emails e where e.job_id = j.id and e.direction = 'in' and e.category = 'rejection') then 'rejected'
  else 'applied' end
where j.status = 'interview' and not exists (select 1 from emails e where e.job_id = j.id and e.direction = 'in' and e.category = 'interview');
with r as (
  select id, category, coalesce(subject, '') as s, coalesce(subject, '') || E'\n' || left(coalesce(body, ''), 6000) as t from emails
), x as (
  select id, category, s, t,
  '(verification code|verify code|one[- ]time (pass)?(code|word)|\motp\M|security code|passcode|access code|(verify|confirm|validate|activate) your (candidate |new |e-?mail )?(e-?mail|identity|account|address|profile)|(e-?mail|account) (verification|activation|confirmation)|your code is)' as v,
  '(reset your password|password reset|change your password|forgot(ten)? (your )?password|new device|sign-?in attempt)' as p,
  '(assessment|skills? test|questionnaire|coding (challenge|test)|online test|one-way interview|video interview|take-?home|work sample|hackerrank|codility|codesignal|hirevue|karat|coderbyte|predictive index|wonderlic)' as a,
  '(we(.ve| have)? (received|got) your (application|resume|submission)|thank(s| you) for (applying|your application|your interest|submitting)|your application (has been |was |is )?(received|submitted|complete)|application (received|confirmation|submitted)|successfully (applied|submitted))' as c,
  '(like to (invite|schedule|set up|arrange)|are you (available|free)|your availability|what (times?|days?) (work|are you)|please (select|choose|pick|book|schedule) (a |an |your )?(time|slot|interview)|calendly\.com|book (a |some )?time|pick a time|invit(e|ing|ation) (you )?(to|for) (a |an )?(interview|phone|video|call)|schedul(e|ing) (a |an |your )?(interview|phone screen|call)|interview (is |has been )?(scheduled|confirmed)|phone screen)' as i
  from r
)
update emails e set kind = case
  when x.category = 'offer' then 'offer'
  when x.category = 'rejection' then 'rejection'
  when x.category = 'confirmation' then 'acknowledgement'
  when x.category = 'interview' then case when x.t ~* x.i then 'interview_invitation' else 'recruiter_inquiry' end
  when x.category = 'action_needed' then case
    when x.s ~* x.v then 'verification_code'
    when x.s ~* x.p then 'account_notice'
    when x.s ~* x.a then 'assessment'
    when x.s ~* x.c then 'acknowledgement'
    when x.t ~* x.a then 'assessment'
    when x.t ~* x.v then 'verification_code'
    when x.t ~* x.p then 'account_notice'
    when x.t ~* x.c then 'acknowledgement'
    else 'action_needed' end
  else 'other' end
from x where e.id = x.id and e.kind is null;
notify pgrst, 'reload schema';