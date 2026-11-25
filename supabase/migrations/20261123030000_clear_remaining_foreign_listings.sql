-- ============================================================================
-- Two German listings that outlived the first cleanup
--
-- The previous migration deleted arbeitnow rows in new/review/queued/skipped.
-- Both survivors show why that was the wrong cut:
--
--   firststars   arbeitnow, but parked in needs_help — the status the applier
--                leaves a posting in when it cannot finish. The previous
--                delete did not cover it, and the inbox matcher DOES search
--                needs_help. That is how four promotional emails came to be
--                matched to a German marketing agency.
--
--   Packmatic    came through remoteok, a US board carrying a German listing
--                with no country attached. Removing one foreign board was
--                never going to be the whole answer.
--
-- Neither was ever applied to, so nothing real is lost. The code fix that
-- accompanies this — remote postings are country-checked, and needs_help is
-- re-examined on every run — is what stops more arriving.
-- ============================================================================

delete from jobs
 where applied_at is null
   and source = 'arbeitnow';

-- Named explicitly rather than matched by pattern. There is no reliable test
-- for "which country is this" in SQL, and a guess like company ilike '%GmbH%'
-- would be a rule about every future row, not a cleanup of this one.
delete from jobs
 where applied_at is null
   and company = 'Packmatic GmbH';
