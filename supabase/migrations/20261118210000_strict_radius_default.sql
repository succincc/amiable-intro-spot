-- ============================================================================
-- Make the radius mean what it says.
--
-- include_unknown_location defaulted to true, on the reasoning that a great
-- many postings say "Multiple Locations" and discarding them throws away real
-- jobs. In practice it did something else: the geocoder's rate limit meant
-- most postings were never measured at all, every unmeasured one counted as
-- "unknown", and a 25-mile search around New Jersey returned jobs in
-- Minneapolis and Bangalore.
--
-- A distance filter that admits India is not a distance filter. The default
-- is now strict — a job that cannot be shown to be within the radius does not
-- appear — and the toggle stays for anyone who would rather see everything.
--
-- The offline state check added alongside this is what makes strict usable:
-- most postings are now resolved or rejected with no lookup at all, so
-- "unknown" has become rare rather than the common case.
-- ============================================================================

alter table search_config alter column include_unknown_location set default false;

-- Existing rows were written under the old default, so they still say true.
-- Without this the change applies only to a database nobody has used yet.
update search_config set include_unknown_location = false where id = 1;
