-- ============================================================================
-- Four applications that were never shown to have been sent
--
-- The applier clicked submit, saw no confirmation text, found no error it
-- knew how to read, and returned "applied" anyway — writing its own doubt
-- into a note that nothing ever surfaced:
--
--     -> applied: submitted, no confirmation text seen
--
-- Sixty days of the applicant's inbox has since been read and contains no
-- receipt from Stripe, Ramp or Instacart. Combined with one of those forms
-- having had just three of its fields filled, the likeliest explanation by
-- some distance is that the submissions did not complete.
--
-- They are moved to needs_help so the panel stops counting them as sent.
-- This does not prove they failed; it stops the system asserting they
-- succeeded on no evidence, which is the thing that made the confirmation
-- gap unreadable for weeks.
--
-- applied_at is kept. It is a true record of when the attempt happened, and
-- the note says plainly what is and is not known about it.
-- ============================================================================

update jobs
   set status      = 'needs_help',
       help_reason = 'unconfirmed',
       confirm_state = null,
       last_error  = 'Submitted with no confirmation seen, and no receipt in 60 days of inbox. '
                     || 'Open the posting and check whether it went through.'
 where status = 'applied'
   and last_error = 'submitted, no confirmation text seen';
