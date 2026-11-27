-- What a posting asks for that the resume sent to it could not honestly
-- show, and how closely the two matched.
--
-- The applier works both out for every application and, until now, said
-- them only in its own log. Kept on the job, they can be shown to the
-- person: a term that many postings ask for and the resume never shows is
-- either experience they do not have, or experience they have and never
-- wrote down — and only they can say which.
alter table jobs add column if not exists ats_match integer;
alter table jobs add column if not exists ats_gaps text[];
