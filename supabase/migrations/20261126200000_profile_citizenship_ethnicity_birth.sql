-- Three facts about the owner that forms keep asking and nothing could answer.
--
-- "Is your ethnicity Hispanic or Latino?" is a yes or a no, and the race on
-- file does not settle it. "Which, if any, of these countries are you a
-- citizen of" needs to know whether there is any citizenship but the one.
-- And "are you over 18" is arithmetic once a date of birth is on file — which
-- is all the date is used for: it is never typed into an application.

alter table profile add column if not exists hispanic_latino text;
alter table profile add column if not exists citizenship text;
alter table profile add column if not exists date_of_birth text;
