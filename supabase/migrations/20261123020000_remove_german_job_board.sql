-- ============================================================================
-- Remove the German job board, and what it left behind
--
-- arbeitnow.com is a German job board. It was enabled as a source alongside
-- the US ones, and it answers "Remote" with no country attached — so a
-- posting from it carried nothing for a distance filter to measure, and the
-- remote branch kept it without ever asking which country it was in.
--
-- That is why German listings kept appearing in a search measured in miles
-- from Princeton, New Jersey, including one that was actually applied to.
--
-- The source is gone from the code. This clears the rows it created and
-- takes it out of the stored preference, so re-enabling it is not one tick
-- away.
-- ============================================================================

-- Jobs that were never acted on: delete outright, they are noise.
delete from jobs
 where source = 'arbeitnow'
   and status in ('new', 'review', 'queued', 'skipped');

-- Anything applied to is left alone on purpose. It is a poor application,
-- but it is a true record of one, and the confirmation-gap count depends on
-- the applied set being honest rather than tidy.

-- Drop it from the saved source list.
update search_config
   set sources = array_remove(sources, 'arbeitnow')
 where sources is not null
   and 'arbeitnow' = any (sources);
