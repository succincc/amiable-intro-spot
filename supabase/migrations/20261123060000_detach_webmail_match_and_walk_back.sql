-- ============================================================================
-- Finish undoing the pipeline move a hand-sent test caused
--
-- The previous migration detached mail sent from the profile address, which
-- was the wrong test. The message came from a personal gmail account — not
-- the profile address, not the connected mailbox, not its own recipient — so
-- nothing recognised it, and the walk-back's safety check then found the job
-- still had an email attached and left it alone.
--
-- The code change beside this raises the bar for free webmail senders: one
-- mention of a company is no longer a match, because a matched email can
-- move a job to 'interview' through sync_job_from_email(), and an employer
-- writes from its own domain or its ATS rather than from gmail.
--
-- Scoped deliberately to jobs still carrying the note from a submission
-- nothing ever confirmed. A genuine receipt from a small employer using
-- webmail, on a job that really was applied to, is left untouched.
-- ============================================================================

update emails e
   set job_id = null
  from jobs j
 where e.job_id = j.id
   and j.last_error = 'submitted, no confirmation text seen'
   and lower(split_part(e.from_addr, '@', 2)) ~
       '^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|zoho|yandex|fastmail|hey)\.';

-- Now walk back any job advanced past 'applied' on no evidence but that.
update jobs j
   set status        = 'needs_help',
       help_reason   = 'unconfirmed',
       confirm_state = null,
       confirmed_at  = null,
       last_error    = 'Submitted with no confirmation seen, and no receipt in 60 days of inbox. '
                       || 'Open the posting and check whether it went through.'
 where j.status in ('interview', 'offer', 'rejected')
   and j.last_error = 'submitted, no confirmation text seen'
   and not exists (
     select 1 from emails e where e.job_id = j.id
   );
