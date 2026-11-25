-- ============================================================================
-- Undo a pipeline move that no employer made
--
-- A test message was sent to the connected mailbox to prove Gmail reading
-- worked. It did prove that. It also did this:
--
--   1. The classifier read it as an INTERVIEW, because a line-wrapped
--      "If your qualifications match our needs, we will contact you to /
--      schedule an interview." was split at the newline and the orphaned
--      half read as a real invitation.
--   2. matchJob attached it to a Ramp application.
--   3. sync_job_from_email() moved that job to status 'interview'.
--   4. Once the classifier was fixed, the re-sync changed the category to
--      'confirmation' — and the trigger fires on UPDATE OF category too, so
--      the same message then set confirm_state = 'confirmed'.
--
-- One self-sent test produced an interview and a confirmation on a real
-- application. Sixty days of that mailbox holds no receipt from Ramp, so
-- neither was real.
--
-- The code change beside this stops self-sent mail matching a job at all.
-- This undoes what the earlier run already wrote.
-- ============================================================================

-- Detach anything the applicant sent themselves. Updating job_id does not
-- re-fire the trigger, which only watches category.
update emails
   set job_id = null
 where job_id is not null
   and lower(from_addr) = lower(coalesce((select email from profile limit 1), ''));

-- Then walk back any job that was advanced past 'applied' while still
-- carrying the note from a submission nothing ever confirmed, and that has
-- no mail from anyone but the applicant behind it.
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
