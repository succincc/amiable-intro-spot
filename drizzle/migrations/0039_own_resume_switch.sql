-- "Send my own resume, as it is."
--
-- By default a resume is written for each posting from the person's own.
-- Someone who would rather every employer got exactly the file they
-- uploaded can switch that off: nothing is rewritten, and their own file is
-- what is attached.

alter table profile add column if not exists tailor_resumes boolean not null default true;